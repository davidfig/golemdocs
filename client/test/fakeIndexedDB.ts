import assert from 'node:assert/strict';

// --- A just-enough IndexedDB: stores are maps; requests answer on the next tick. -----------------

export function fakeIndexedDB(): unknown {
  const databases = new Map<string, Map<string, { keyPath?: string; rows: Map<unknown, unknown> }>>();
  const request = (produce: () => unknown) => {
    const req: { result?: unknown; error: null; onsuccess?: () => void; onerror?: () => void } = { error: null };
    setTimeout(() => {
      req.result = produce();
      req.onsuccess?.();
    }, 0);
    return req;
  };
  return {
    open(name: string) {
      const first = !databases.has(name);
      if (first) databases.set(name, new Map());
      const stores = databases.get(name)!;
      const db = {
        createObjectStore(store: string, options?: { keyPath?: string }) {
          stores.set(store, { keyPath: options?.keyPath, rows: new Map() });
        },
        transaction(names: string | string[]) {
          const allowed = new Set([names].flat());
          return {
            objectStore(store: string) {
              assert.ok(allowed.has(store), `store ${store} not in transaction`);
              const s = stores.get(store)!;
              return {
                get: (key: unknown) => request(() => structuredClone(s.rows.get(key))),
                getAll: () => request(() => [...s.rows.values()].map((v) => structuredClone(v))),
                put(value: unknown, key?: unknown) {
                  s.rows.set(s.keyPath ? (value as Record<string, unknown>)[s.keyPath] : key, structuredClone(value));
                  return request(() => undefined);
                },
                delete(key: unknown) {
                  s.rows.delete(key);
                  return request(() => undefined);
                },
              };
            },
            set oncomplete(fn: () => void) {
              setTimeout(fn, 0);
            },
            set onerror(_fn: unknown) {},
            set onabort(_fn: unknown) {},
          };
        },
      };
      const req: { result?: unknown; error: null; onupgradeneeded?: () => void; onsuccess?: () => void } = { error: null, result: db };
      setTimeout(() => {
        if (first) (req.onupgradeneeded as ((e: unknown) => void) | undefined)?.({ oldVersion: 0 });
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}
