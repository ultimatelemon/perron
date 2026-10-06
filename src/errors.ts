export { RateLimitedError as RateLimited } from './lib/fetch-client.ts';

export interface StationCandidate {
  name: string;
  code: string;
}

export class StationNotFound extends Error {
  constructor(query: string) {
    super(`No station matches "${query}". Try search_stations.`);
    this.name = 'StationNotFound';
  }
}

export class AmbiguousStation extends Error {
  readonly candidates: StationCandidate[];

  constructor(query: string, candidates: StationCandidate[]) {
    const list = candidates.map((c) => `${c.name} (${c.code})`).join(', ');
    super(
      `"${query}" matches several stations: ${list}. Pass one of the codes.`
    );
    this.name = 'AmbiguousStation';
    this.candidates = candidates;
  }
}

export class UpstreamError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/** Domain-level "nothing there", e.g. an unknown train number. */
export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}
