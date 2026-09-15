type Entry = { value: unknown; leases: number };
const KEY = Symbol.for("emasphere.slack-thread-focus.shared-runtime.v1");

/** OpenClaw can load the same plugin into several scoped registries in one process. */
export function acquireSharedRuntime<T>(key: string, create: () => T): { value: T; release: () => boolean } {
  const host = globalThis as unknown as { [key: symbol]: Map<string, Entry> | undefined };
  const entries = host[KEY] ??= new Map();
  let entry = entries.get(key);
  if (!entry) {
    entry = { value: create(), leases: 0 };
    entries.set(key, entry);
  }
  entry.leases++;
  let released = false;
  return {
    value: entry.value as T,
    release: () => {
      if (released) return false;
      released = true;
      if (--entry.leases !== 0) return false;
      if (entries.get(key) === entry) entries.delete(key);
      return true;
    },
  };
}
