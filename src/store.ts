import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThreadReference, ThreadState } from "./types.js";

type StateFile = {
  version: 1;
  threads: Record<string, ThreadState>;
};

const EMPTY_STATE: StateFile = { version: 1, threads: {} };

function isFiniteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseThreadState(value: unknown): ThreadState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const state = value as Record<string, unknown>;
  if ((state.mode !== "active" && state.mode !== "muted") ||
      !isFiniteCount(state.lastMuteCount) ||
      !isFiniteCount(state.lastResumeCount) ||
      !isFiniteCount(state.resumedMuteCount) ||
      !isFiniteCount(state.updatedAt)) {
    return undefined;
  }
  return {
    mode: state.mode,
    lastMuteCount: state.lastMuteCount,
    lastResumeCount: state.lastResumeCount,
    resumedMuteCount: state.resumedMuteCount,
    ...(typeof state.resumePending === "boolean" ? { resumePending: state.resumePending } : {}),
    updatedAt: state.updatedAt,
  };
}

function parseStateFile(raw: string): StateFile {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("state file must contain an object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.threads === null ||
      typeof candidate.threads !== "object" || Array.isArray(candidate.threads)) {
    throw new Error("unsupported state file format");
  }

  const threads: Record<string, ThreadState> = {};
  for (const [key, value] of Object.entries(candidate.threads as Record<string, unknown>)) {
    const state = parseThreadState(value);
    if (state) {
      threads[key] = state;
    }
  }
  return { version: 1, threads };
}

export function threadStateKey(reference: ThreadReference): string {
  return JSON.stringify([
    reference.agentId,
    reference.accountId,
    reference.channelId,
    reference.threadTs,
  ]);
}

export class JsonThreadStateStore {
  private state: StateFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  mutate(
    reference: ThreadReference,
    reducer: (previous: ThreadState | undefined) => ThreadState | undefined,
  ): Promise<ThreadState | undefined> {
    return this.serialized(async () => {
      const state = await this.load();
      const pruned = this.prune(state);
      const key = threadStateKey(reference);
      const previous = state.threads[key];
      const next = reducer(previous);
      const changed = JSON.stringify(previous) !== JSON.stringify(next);

      if (next) {
        state.threads[key] = next;
      } else {
        delete state.threads[key];
      }
      if (changed || pruned) {
        await this.persist(state);
      }
      return next;
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<StateFile> {
    if (this.state) {
      return this.state;
    }
    try {
      this.state = parseStateFile(await readFile(this.filePath, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.state = { ...EMPTY_STATE, threads: {} };
    }
    return this.state;
  }

  private prune(state: StateFile): boolean {
    const cutoff = this.now() - this.ttlMs;
    let changed = false;
    for (const [key, value] of Object.entries(state.threads)) {
      if (value.updatedAt < cutoff) {
        delete state.threads[key];
        changed = true;
      }
    }
    return changed;
  }

  private async persist(state: StateFile): Promise<void> {
    const directory = dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
