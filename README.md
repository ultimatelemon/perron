# perron

An [MCP](https://modelcontextprotocol.io) server for Dutch Railways (NS) travel
information. It gives Claude, or any other MCP client, the journey planner, live
departure and arrival boards, disruptions and engineering works, fares, train
composition and crowding, and station facilities.

> **Not an official NS project.** perron uses the public
> [NS API portal](https://apiportal.ns.nl) with your own API key. NS is not
> involved and does not support it.

## Tools

| Tool                 | What it answers                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `search_stations`    | Find a station by name, synonym, NS code or UIC code, typo-tolerant                              |
| `plan_trip`          | Journey options with live delays, track changes, transfers, crowding and the fare                |
| `trip_details`       | Refresh one `plan_trip` option by its `tripId`: live status plus every intermediate stop         |
| `trip_price`         | Domestic fare: single or return, 1st or 2nd class, adults and children, joint-journey discount   |
| `departures`         | Live departure board: delays, destinations, tracks and track changes, cancellations, notices     |
| `arrivals`           | Live arrival board                                                                               |
| `train_journey`      | All stops of one train with times, tracks, delays and crowding                                   |
| `disruptions`        | Disruptions, engineering works and calamities, nationwide or per station, with details by id     |
| `train_composition`  | Rolling stock, units, coaches, length, facilities, first-class seats, shortened or not, crowding |
| `station_facilities` | OV-fiets availability, lift status, and facilities and shops with today's opening hours          |

Every tool accepts station names (`"Utrecht"`, `"Den Bosch"`), NS codes (`UT`)
and UIC codes (`8400621`). When a name fits several stations, the tool returns
an error listing them so the assistant can pick one.

Responses are compact JSON plus a one-line-per-item text summary. Times are in
Europe/Amsterdam, `HH:mm`, with the date only when it is not today. Delays are
whole minutes, prices are euros, and track changes, cancellations and
disruptions are separate fields rather than buried in text.

## No authentication: put it behind something

perron has **no auth of its own**. Anyone who can reach `/mcp` can spend your NS
API key's rate limit. Run it on localhost, or behind a reverse proxy or gateway
that authenticates (an OAuth gateway, Cloudflare Access, Tailscale, a VPN, …).
Do not expose it to the internet as is.

## Getting an NS API key

1. Create an account at [apiportal.ns.nl](https://apiportal.ns.nl).
2. Under **Products**, subscribe to **Ns-App**. That one product covers every
   API perron uses.
3. Your profile then shows a primary and a secondary key. Use either one as
   `NS_API_KEY`; keep the other for rotating without downtime.

The key allows 300 requests per 5 minutes. perron stays under that with a
token bucket, respects `Retry-After` on a 429, and caches responses (see below).

## Configuration

| Variable     | Default   | Purpose                                                                |
| ------------ | --------- | ---------------------------------------------------------------------- |
| `NS_API_KEY` | —         | Required. Subscription key for the Ns-App product.                     |
| `PORT`       | `3000`    | HTTP port.                                                             |
| `HOST`       | `0.0.0.0` | Interface to listen on. Use `127.0.0.1` to keep it local.              |
| `BASE_PATH`  | _(empty)_ | Prefix when a proxy forwards a sub-path unchanged, e.g. `/ns`.         |
| `REDIS_URL`  | _(empty)_ | Redis for the cache, e.g. `redis://redis:6379`. Without it: in memory. |
| `LOG_LEVEL`  | `info`    | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.        |

Endpoints: `POST /mcp` (Streamable HTTP, stateless) and `GET /healthz`. With a
`BASE_PATH` both are also served under that prefix.

## Running

### Docker

```bash
docker run --rm -p 127.0.0.1:3000:3000 -e NS_API_KEY=your-key \
  ghcr.io/ultimatelemon/perron:latest
```

The image runs as a non-root user and has a health check on `/healthz`.

### From source

Needs Node 24.

```bash
git clone https://github.com/ultimatelemon/perron.git
cd perron
npm ci
cp .env.example .env   # and fill in NS_API_KEY
npm run dev            # http://localhost:3000/mcp
```

`npm run build && npm start` runs the compiled version.

## Connecting a client

### Claude Code

```bash
claude mcp add --transport http perron http://localhost:3000/mcp
```

### Claude Desktop and claude.ai

Add a custom connector with the public URL of your deployment. These clients
reach the server from the internet, so this only works behind an authenticating
gateway that speaks MCP's OAuth flow.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose transport "Streamable HTTP" and URL `http://localhost:3000/mcp`.

## Caching

| Data                                 | Kept for   |
| ------------------------------------ | ---------- |
| Station list                         | 24 hours   |
| Station facilities, fares            | 1 hour     |
| OV-fiets availability, lift status   | 2 minutes  |
| Disruptions                          | 1 minute   |
| Trips, boards, journeys, composition | 30 seconds |

## Development

```bash
npm test              # vitest, against recorded responses in test/fixtures
npm run lint
npm run typecheck
npm run format:check
npm run probe         # calls every NS endpoint once and saves raw responses to fixtures/
node scripts/smoke.ts http://localhost:3000/mcp   # calls every tool on a running server
```

The NS OpenAPI specs are not in this repository. Download them from the API
portal into `specs/`, which is ignored by git. A few things the specs do not tell you, found by calling the
real API:

- `/reisinformatie-api/api/v3/price` returns a 500 for every request on the
  Ns-App product; perron uses `/api/v2/price`, which returns the same fares.
- The Virtual Train API spec lists both `/v1/...` and `/api/v1/...`; only
  `/v1/...` answers.
- The Places API rejects `Accept-Language: *`, which Node's `fetch` sends by
  default, so every request sets a language explicitly.
- Departures and arrivals use `/api/v2/departures` and `/api/v2/arrivals`. Their
  successor, the timetable API, is not part of the Ns-App product. Both calls
  live in one function in `src/ns/reisinformatie.ts`.

The parts that know nothing about NS live in their own packages:
[`@ultimatelemon-eu/fetch-client`](https://www.npmjs.com/package/@ultimatelemon-eu/fetch-client)
(rate limiting, Retry-After, retries) and
[`@ultimatelemon-eu/mcp-http`](https://www.npmjs.com/package/@ultimatelemon-eu/mcp-http)
(the Streamable HTTP server). `src/lib/` keeps the cache, with Redis or
in-memory storage.

## License

[MIT](./LICENSE)
