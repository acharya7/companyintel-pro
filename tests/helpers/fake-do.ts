/**
 * Minimal Durable Object state for tests.
 *
 * It implements what the coordinator and worker actually use — `storage.get` for one
 * key or a batch, `put` with a key/value or a record, `delete`, alarms — and exposes
 * the map so a test can inspect or corrupt durable state deliberately (for example to
 * expire a lease or to inject a spent budget).
 *
 * The container handle is attached by the caller: in production it is
 * `ctx.container`, which only exists for a class declared in `[[containers]]`.
 */

export interface FakeDoState {
  storage: {
    get<T = unknown>(key: string | string[]): Promise<T | Map<string, T> | undefined>;
    put<T>(key: string | Record<string, unknown>, value?: T): Promise<void>;
    delete(key: string | string[]): Promise<boolean>;
    setAlarm(at: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
    list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  container?: unknown;
  /** Alarms armed by the class under test, newest last. */
  alarms: number[];
  /** Durable state, so a test can seed or inspect it. */
  map: Map<string, unknown>;
}

export function fakeDoState(options: { container?: unknown; seed?: Record<string, unknown> } = {}): FakeDoState {
  const map = new Map<string, unknown>(Object.entries(options.seed ?? {}));
  const alarms: number[] = [];
  const state: FakeDoState = {
    map,
    alarms,
    container: options.container,
    storage: {
      async get<T>(key: string | string[]): Promise<T | Map<string, T> | undefined> {
        if (Array.isArray(key)) {
          const out = new Map<string, T>();
          for (const entry of key) {
            if (map.has(entry)) out.set(entry, map.get(entry) as T);
          }
          return out;
        }
        return map.get(key) as T | undefined;
      },
      async put<T>(key: string | Record<string, unknown>, value?: T): Promise<void> {
        if (typeof key === "string") {
          map.set(key, value);
          return;
        }
        for (const [entry, entryValue] of Object.entries(key)) map.set(entry, entryValue);
      },
      async delete(key: string | string[]): Promise<boolean> {
        if (Array.isArray(key)) {
          let removed = false;
          for (const entry of key) removed = map.delete(entry) || removed;
          return removed;
        }
        return map.delete(key);
      },
      async setAlarm(at: number | Date): Promise<void> {
        alarms.push(typeof at === "number" ? at : at.getTime());
      },
      async deleteAlarm(): Promise<void> {
        alarms.length = 0;
      },
      async list<T>(listOptions?: { prefix?: string }): Promise<Map<string, T>> {
        const prefix = listOptions?.prefix ?? "";
        return new Map([...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][]);
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
  return state;
}
