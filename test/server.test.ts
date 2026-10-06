import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStationProvider, type Deps } from '../src/context.ts';
import { createCache } from '../src/lib/cache.ts';
import { silentLogger } from '../src/lib/logger.ts';
import { startMcpHttpServer, type McpHttpServer } from '../src/lib/mcp-http.ts';
import { createNsClient } from '../src/ns/client.ts';
import { createPerronServer } from '../src/server.ts';
import { FIXTURE_NOW, fixture } from './helpers.ts';

const ROUTES: [RegExp, string][] = [
  [/\/nsapp-stations\/v3$/, 'stations'],
  [/\/api\/v3\/trips$/, 'trips'],
  [/\/api\/v3\/trips\/trip$/, 'trip-single'],
  [/\/api\/v2\/price$/, 'price'],
  [/\/api\/v2\/departures$/, 'departures'],
  [/\/api\/v2\/arrivals$/, 'arrivals'],
  [/\/api\/v2\/journey$/, 'journey'],
  [/\/disruptions\/v3(\/station\/\w+)?$/, 'disruptions'],
  [/\/virtual-train-api\/v1\/trein\//, 'virtual-train'],
  [/\/virtual-train-api\/v1\/prognose\//, 'virtual-train-prognose'],
  [/\/places-api\/v2\/places$/, 'places'],
  [/\/places-api\/v2\/ovfiets$/, 'ovfiets'],
  [/\/places-api\/v1\/stationfacility\/lifts$/, 'lifts']
];

const requests: { url: URL; key: string | null }[] = [];

const fakeFetch = ((input: URL, init?: RequestInit) => {
  const url = new URL(input);
  requests.push({
    url,
    key: new Headers(init?.headers).get('ocp-apim-subscription-key')
  });
  const route = ROUTES.find(([pattern]) => pattern.test(url.pathname));
  if (!route) {
    return Promise.resolve(
      new Response('{"message":"not found"}', { status: 404 })
    );
  }
  return Promise.resolve(
    new Response(JSON.stringify(fixture(route[1])), { status: 200 })
  );
}) as typeof fetch;

let http: McpHttpServer;
let client: Client;

beforeAll(async () => {
  const ns = createNsClient({ apiKey: 'test-key', fetch: fakeFetch });
  const cache = await createCache();
  const deps: Deps = {
    ns,
    cache,
    stations: createStationProvider(ns, cache),
    now: () => FIXTURE_NOW,
    logger: silentLogger
  };
  http = await startMcpHttpServer({
    createMcpServer: () => createPerronServer(deps),
    port: 0,
    host: '127.0.0.1',
    basePath: '/ns'
  });
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
});

afterAll(async () => {
  await client.close();
  await http.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError ?? false,
    text: (result.content as { text: string }[])[0]?.text ?? '',
    data: result.structuredContent as Record<string, unknown>
  };
}

describe('perron over Streamable HTTP', () => {
  it('serves the mount path from BASE_PATH', () => {
    expect(http.url).toMatch(/\/ns\/mcp$/);
  });

  it('answers /healthz', async () => {
    const res = await fetch(http.url.replace(/\/mcp$/, '/healthz'));
    expect(res.status).toBe(200);
  });

  it('rejects GET on /mcp in stateless mode', async () => {
    const res = await fetch(http.url);
    expect(res.status).toBe(405);
  });

  it('lists the ten tools with descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'arrivals',
      'departures',
      'disruptions',
      'plan_trip',
      'search_stations',
      'station_facilities',
      'train_composition',
      'train_journey',
      'trip_details',
      'trip_price'
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('plans a trip by station names and resolves them to UIC codes', async () => {
    const result = await call('plan_trip', { from: 'Utrecht', to: 'Den Haag' });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      from: 'Utrecht Centraal',
      to: 'Den Haag Centraal'
    });
    expect((result.data['options'] as unknown[]).length).toBe(4);
    const tripRequest = requests.find((r) =>
      r.url.pathname.endsWith('/v3/trips')
    );
    expect(tripRequest?.url.searchParams.get('originUicCode')).toBe('8400621');
    expect(tripRequest?.url.searchParams.get('destinationUicCode')).toBe(
      '8400282'
    );
  });

  it('hands out tripIds instead of ctxRecon and resolves them in trip_details', async () => {
    const planned = await call('plan_trip', {
      from: 'UT',
      to: 'GVC',
      maxOptions: 2
    });
    const options = planned.data['options'] as { tripId?: string }[];
    expect(JSON.stringify(planned.data)).not.toContain('ctxRecon');
    const tripId = options[0]?.tripId;
    expect(tripId).toMatch(/^[\w-]{10}$/);

    const details = await call('trip_details', { tripId });
    expect(details.isError).toBe(false);
    expect(details.data).toMatchObject({ tripId });
    const detailRequest = requests.find((r) =>
      r.url.pathname.endsWith('/v3/trips/trip')
    );
    expect(detailRequest?.url.searchParams.get('ctxRecon')).toMatch(/^arnu\|/);
  });

  it('reports an unknown tripId as a readable error', async () => {
    const result = await call('trip_details', { tripId: 'doesnotexi' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Run plan_trip again');
  });

  it('sends the subscription key on every upstream call', () => {
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.key === 'test-key')).toBe(true);
    expect(requests.every((r) => !r.url.toString().includes('test-key'))).toBe(
      true
    );
  });

  it('returns an ambiguous-station error with candidates', async () => {
    const result = await call('departures', { station: 'Ede' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ED');
    expect(result.text).toContain('EDC');
    expect(result.text).not.toMatch(/at .*\.ts:\d+/);
  });

  it('turns an upstream 404 into a readable error', async () => {
    const result = await call('disruptions', { type: 'calamity', id: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('NS has no data for this request.');
  });

  it.each([
    ['search_stations', { query: 'den bosch' }],
    ['trip_price', { from: 'UT', to: 'GVC' }],
    ['departures', { station: 'UT', limit: 5 }],
    ['arrivals', { station: 'UT' }],
    ['train_journey', { trainNumber: 3529 }],
    ['disruptions', {}],
    ['disruptions', { station: 'Utrecht' }],
    ['train_composition', { trainNumber: 3529, station: 'UT' }],
    ['station_facilities', { station: 'UT', include: ['lifts', 'ovfiets'] }]
  ])('%s %j works', async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBe(false);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.data).toBeTypeOf('object');
  });
});
