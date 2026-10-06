import type { SharedVehicle } from '../deelmobiliteit/client.ts';
import { normalize } from '../resolve.ts';
import { compact } from './util.ts';

export interface Point {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceMeters(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Eight-point compass direction from `a` towards `b`. */
export function direction(a: Point, b: Point): string {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8]!;
}

/** "GO Sharing", "go-sharing" and "gosharing" are the same operator. */
export function operatorKey(name: string): string {
  return normalize(name).replace(/ /g, '');
}

export interface NearbyOptions {
  operators?: string[] | undefined;
  formFactors?: string[] | undefined;
  radiusM: number;
  limit: number;
  includeUnavailable: boolean;
}

function toItem(origin: Point, v: SharedVehicle, distance: number) {
  return compact({
    operator: v.system_id,
    type: v.form_factor,
    propulsion: v.propulsion_type,
    distanceM: Math.round(distance),
    direction: direction(origin, v),
    lat: Math.round(v.lat * 1e6) / 1e6,
    lon: Math.round(v.lon * 1e6) / 1e6,
    reserved: v.is_reserved,
    disabled: v.is_disabled
  });
}

export type NearbyVehicle = ReturnType<typeof toItem>;

export function findNearby(
  vehicles: SharedVehicle[],
  origin: Point,
  options: NearbyOptions
) {
  const operators = options.operators?.length
    ? new Set(options.operators.map(operatorKey))
    : undefined;
  const formFactors = options.formFactors?.length
    ? new Set(options.formFactors)
    : undefined;

  const matching: { v: SharedVehicle; d: number }[] = [];
  for (const v of vehicles) {
    if (operators && !operators.has(operatorKey(v.system_id))) continue;
    if (formFactors && !formFactors.has(v.form_factor ?? 'other')) continue;
    if (!options.includeUnavailable && (v.is_reserved || v.is_disabled)) {
      continue;
    }
    matching.push({ v, d: distanceMeters(origin, v) });
  }
  matching.sort((a, b) => a.d - b.d);

  const inRadius = matching.filter((m) => m.d <= options.radiusM);
  const byOperator: Record<string, number> = {};
  for (const { v } of inRadius) {
    byOperator[v.system_id] = (byOperator[v.system_id] ?? 0) + 1;
  }
  const first = matching[0];
  return {
    total: inRadius.length,
    byOperator,
    vehicles: inRadius
      .slice(0, options.limit)
      .map((m) => toItem(origin, m.v, m.d)),
    // When nothing is in range, the closest one still tells how far to walk.
    closestOutsideRadius:
      inRadius.length === 0 && first
        ? toItem(origin, first.v, first.d)
        : undefined
  };
}

/** The operators in the feed, so an unknown name can be answered with the real ones. */
export function knownOperators(vehicles: SharedVehicle[]): string[] {
  return [...new Set(vehicles.map((v) => v.system_id))].sort();
}
