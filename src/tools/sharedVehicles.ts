import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { NotFound } from '../errors.ts';
import { formatTime } from '../format/time.ts';
import {
  findNearby,
  knownOperators,
  operatorKey,
  type NearbyVehicle,
  type Point
} from '../format/vehicles.ts';
import { fail, ok, READ_ONLY, run } from './result.ts';

const FORM_FACTORS = [
  'bicycle',
  'cargo_bicycle',
  'moped',
  'scooter_standing',
  'scooter_seated',
  'car',
  'other'
] as const;

function line(v: NearbyVehicle): string {
  const what = [
    v.operator,
    v.type,
    v.propulsion === 'electric_assist' ? 'e-assist' : undefined
  ]
    .filter(Boolean)
    .join(' ');
  const flags = [v.reserved ? 'reserved' : '', v.disabled ? 'disabled' : '']
    .filter(Boolean)
    .join(', ');
  return `${what}: ${String(v.distanceM)} m ${v.direction ?? ''}${flags ? ` (${flags})` : ''}`;
}

export function registerSharedVehicles(server: McpServer, deps: Deps) {
  server.registerTool(
    'shared_vehicles',
    {
      title: 'Shared vehicles nearby',
      description:
        'Available shared vehicles (deelscooters, deelfietsen, e-steps, deelauto’s) near a station or a coordinate, from the open Dashboard Deelmobiliteit feed covering all Dutch operators such as Check, Felyx, GO Sharing, Cykl and Donkey Republic. Returns the nearest vehicles with walking distance and compass direction, plus a count per operator. Use it for the first or last mile of a train trip, e.g. "is there a Check scooter at the station when I arrive?". A Dutch "scooter" or "deelscooter" is usually a moped.',
      inputSchema: {
        station: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Search around this station: name (e.g. "Rotterdam Centraal"), NS code or UIC code. Or pass lat and lon instead.'
          ),
        lat: z
          .number()
          .min(-90)
          .max(90)
          .optional()
          .describe('Latitude (WGS84)'),
        lon: z
          .number()
          .min(-180)
          .max(180)
          .optional()
          .describe('Longitude (WGS84)'),
        operator: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Only these operators, e.g. ["check"] or ["felyx", "gosharing"]. Case and spaces do not matter. Default: all.'
          ),
        type: z
          .array(z.enum(FORM_FACTORS))
          .optional()
          .describe(
            'Only these vehicle types. moped = deelscooter, scooter_standing = e-step. Default: all.'
          ),
        radius: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .default(500)
          .describe('Search radius in metres, default 500'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Most vehicles to list, nearest first; default 10'),
        includeUnavailable: z
          .boolean()
          .default(false)
          .describe('Also list reserved and disabled vehicles')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        let origin: Point;
        let place: string;
        if (input.station) {
          const s = (await deps.stations()).resolve(input.station);
          if (!s.location) {
            throw new NotFound(`NS has no coordinates for ${s.name}.`);
          }
          origin = { lat: s.location.lat, lon: s.location.lng };
          place = s.name;
        } else if (input.lat !== undefined && input.lon !== undefined) {
          origin = { lat: input.lat, lon: input.lon };
          place = `${String(input.lat)},${String(input.lon)}`;
        } else {
          return fail('Pass a station, or both lat and lon.');
        }

        const snapshot = await deps.vehicles();
        if (input.operator?.length) {
          const known = knownOperators(snapshot.vehicles);
          const keys = new Set(known.map(operatorKey));
          const unknown = input.operator.filter(
            (o) => !keys.has(operatorKey(o))
          );
          if (unknown.length === input.operator.length) {
            return fail(
              `No vehicles from ${unknown.join(', ')} in the feed right now. Operators in the feed: ${known.join(', ')}.`
            );
          }
        }

        const nearby = findNearby(snapshot.vehicles, origin, {
          operators: input.operator,
          formFactors: input.type,
          radiusM: input.radius,
          limit: input.limit,
          includeUnavailable: input.includeUnavailable
        });
        const updated = formatTime(snapshot.updated, deps.now());
        const data = {
          near: place,
          lat: origin.lat,
          lon: origin.lon,
          radiusM: input.radius,
          ...(updated ? { updated } : {}),
          ...nearby
        };

        const what = [input.operator?.join('/'), input.type?.join('/')]
          .filter(Boolean)
          .join(' ');
        const lines = [
          `${String(nearby.total)} ${what ? `${what} ` : ''}vehicle(s) within ${String(input.radius)} m of ${place}${updated ? ` (feed ${updated})` : ''}`,
          ...nearby.vehicles.map(line)
        ];
        if (nearby.closestOutsideRadius) {
          lines.push(`Closest: ${line(nearby.closestOutsideRadius)}`);
        }
        return ok(lines.join('\n'), data);
      })
  );
}
