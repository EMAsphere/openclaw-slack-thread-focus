import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { JsonThreadStateStore, threadStateKey } from "../src/store.js";
import type { ThreadReference, ThreadState } from "../src/types.js";

const reference: ThreadReference = {
  agentId: "roger",
  accountId: "default",
  channelId: "C123",
  threadTs: "1712000000.000001",
};

const muted: ThreadState = {
  mode: "muted",
  lastMuteCount: 1,
  lastResumeCount: 0,
  resumedMuteCount: 0,
  updatedAt: 10_000,
};

describe("JsonThreadStateStore", () => {
  it("persists and reloads state atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thread-focus-"));
    const file = join(directory, "state.json");
    const first = new JsonThreadStateStore(file, 100_000, () => 10_000);
    await first.mutate(reference, () => muted);

    const second = new JsonThreadStateStore(file, 100_000, () => 10_000);
    const loaded = await second.mutate(reference, (previous) => previous);
    expect(loaded).toEqual(muted);

    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      threads: Record<string, ThreadState>;
    };
    expect(persisted.threads[threadStateKey(reference)]).toEqual(muted);
  });

  it("isolates agents in the same thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thread-focus-"));
    const store = new JsonThreadStateStore(join(directory, "state.json"), 100_000, () => 10_000);
    await store.mutate(reference, () => muted);
    const other = { ...reference, agentId: "maurice" };
    expect(await store.mutate(other, (previous) => previous)).toBeUndefined();
  });

  it("prunes expired entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thread-focus-"));
    const file = join(directory, "state.json");
    const store = new JsonThreadStateStore(file, 50, () => 10_000);
    await store.mutate(reference, () => ({ ...muted, updatedAt: 9_900 }));
    expect(await store.mutate(reference, (previous) => previous)).toBeUndefined();
  });
});
