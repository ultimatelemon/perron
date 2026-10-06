import { createFetchClient, HttpError } from '@ultimatelemon-eu/fetch-client';
import { UpstreamError } from '../errors.ts';
import type { Logger } from '../lib/logger.ts';

export const DEELMOBILITEIT_API = 'https://api.datadeelmobiliteit.nl';

const SERVICE = 'Dashboard Deelmobiliteit';

/** One unrented vehicle in public space, as the open Available Vehicles API returns it. */
export interface SharedVehicle {
  system_id: string;
  vehicle_id?: string;
  lat: number;
  lon: number;
  is_reserved?: boolean;
  is_disabled?: boolean;
  form_factor?: string;
  propulsion_type?: string;
}

export interface VehiclesResponse {
  last_updated?: string;
  ttl?: number;
  data?: { vehicles?: SharedVehicle[] };
}

export interface VehicleSnapshot {
  updated: string | undefined;
  vehicles: SharedVehicle[];
}

export interface VehiclesClientOptions {
  logger?: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function createVehiclesClient(
  options: VehiclesClientOptions = {}
): () => Promise<VehiclesResponse> {
  const client = createFetchClient({
    baseUrl: options.baseUrl ?? DEELMOBILITEIT_API,
    // The open API has no published limit; the snapshot cache keeps us at a few calls a minute.
    rateLimit: { limit: 30, windowMs: 60_000, burst: 5, maxWaitMs: 8000 },
    // The response holds every shared vehicle in the country, several MB.
    timeoutMs: 20_000,
    retries: 1,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });

  return async () => {
    try {
      return await client.get<VehiclesResponse>('/vehicles');
    } catch (error) {
      if (error instanceof HttpError) {
        throw new UpstreamError(
          error.status,
          `${SERVICE} API ${String(error.status)}: ${error.message}`,
          SERVICE
        );
      }
      throw error;
    }
  };
}

const MIN_TTL_MS = 15_000;
const MAX_TTL_MS = 120_000;

/*
 * Keeps the latest nationwide snapshot in process memory rather than in the
 * shared cache: it is too large to round-trip through Redis every 30 seconds.
 * Concurrent callers share one request, and a stale snapshot beats an error.
 */
export function createVehicleProvider(
  load: () => Promise<VehiclesResponse>,
  now: () => number = Date.now
): () => Promise<VehicleSnapshot> {
  let current: { snapshot: VehicleSnapshot; expires: number } | undefined;
  let pending: Promise<VehicleSnapshot> | undefined;

  const refresh = async () => {
    const body = await load();
    const snapshot: VehicleSnapshot = {
      updated: body.last_updated,
      vehicles: (body.data?.vehicles ?? []).filter(
        (v) =>
          typeof v.system_id === 'string' &&
          Number.isFinite(v.lat) &&
          Number.isFinite(v.lon)
      )
    };
    const ttl = Math.min(
      MAX_TTL_MS,
      Math.max(MIN_TTL_MS, (body.ttl ?? 30) * 1000)
    );
    current = { snapshot, expires: now() + ttl };
    return snapshot;
  };

  return () => {
    if (current && now() < current.expires) {
      return Promise.resolve(current.snapshot);
    }
    pending ??= refresh().finally(() => {
      pending = undefined;
    });
    if (current) {
      const stale = current.snapshot;
      return pending.catch(() => stale);
    }
    return pending;
  };
}
