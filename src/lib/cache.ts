import { createClient } from 'redis';
import { silentLogger, type Logger } from './logger.ts';

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Returns the cached value, or runs `load` once even when called concurrently. */
  wrap<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface Store {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  close(): Promise<void>;
}

export function memoryStore(maxEntries = 1000, now = Date.now): Store {
  const entries = new Map<string, { value: string; expires: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return Promise.resolve(undefined);
      if (entry.expires <= now()) {
        entries.delete(key);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(entry.value);
    },
    set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      // Map iterates in insertion order, so the first key is the oldest write.
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return Promise.resolve();
    },
    close() {
      entries.clear();
      return Promise.resolve();
    }
  };
}

async function redisStore(url: string, logger: Logger): Promise<Store> {
  const client = createClient({ url });
  client.on('error', (error: unknown) => {
    logger.warn({ err: String(error) }, 'redis error');
  });
  await client.connect();
  return {
    async get(key) {
      return (await client.get(key)) ?? undefined;
    },
    async set(key, value, ttlMs) {
      await client.set(key, value, {
        expiration: { type: 'PX', value: ttlMs }
      });
    },
    async close() {
      await client.close();
    }
  };
}

export interface CacheOptions {
  redisUrl?: string | undefined;
  prefix?: string;
  logger?: Logger;
}

export async function createCache(options: CacheOptions = {}): Promise<Cache> {
  const { prefix = '', logger = silentLogger } = options;
  const store = options.redisUrl
    ? await redisStore(options.redisUrl, logger)
    : memoryStore();
  const inflight = new Map<string, Promise<unknown>>();

  // A cache that is down must not take the tools down with it: read and write
  // failures are logged and treated as a miss.
  const cache: Cache = {
    async get<T>(key: string) {
      try {
        const raw = await store.get(prefix + key);
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      } catch (error) {
        logger.warn({ key, err: String(error) }, 'cache read failed');
        return undefined;
      }
    },
    async set(key, value, ttlMs) {
      try {
        await store.set(prefix + key, JSON.stringify(value), ttlMs);
      } catch (error) {
        logger.warn({ key, err: String(error) }, 'cache write failed');
      }
    },
    async wrap<T>(key: string, ttlMs: number, load: () => Promise<T>) {
      const hit = await cache.get<T>(key);
      if (hit !== undefined) return hit;
      const pending = inflight.get(key);
      if (pending) return pending as Promise<T>;
      const promise = (async () => {
        try {
          const value = await load();
          await cache.set(key, value, ttlMs);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    },
    close: () => store.close()
  };
  return cache;
}
