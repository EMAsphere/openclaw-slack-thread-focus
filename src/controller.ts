import { requestResumeWithoutSnapshot, transitionThreadState } from "./state-machine.js";
import type { JsonThreadStateStore } from "./store.js";
import type {
  FocusDecision,
  PluginLogger,
  ReactionSnapshot,
  ThreadReference,
} from "./types.js";

export type ReactionReader = {
  getSnapshot: (channelId: string, threadTs: string) => Promise<ReactionSnapshot>;
};

export class ThreadFocusController {
  private readonly cache = new Map<string, ReactionSnapshot>();
  private readonly inFlight = new Map<string, Promise<ReactionSnapshot>>();

  constructor(
    private readonly store: JsonThreadStateStore,
    private readonly reactions: ReactionReader | undefined,
    private readonly cacheTtlMs: number,
    private readonly logger: PluginLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(
    reference: ThreadReference,
    explicitMention: boolean,
    forceRefresh = false,
  ): Promise<FocusDecision> {
    let snapshot: ReactionSnapshot | undefined;
    try {
      snapshot = await this.readSnapshot(reference, forceRefresh);
    } catch (error) {
      this.logger.warn?.(
        `slack-thread-focus: reaction lookup failed for ${reference.channelId}:${reference.threadTs} (${String(error)})`,
      );
    }

    if (!snapshot) {
      return this.evaluateStored(reference, explicitMention);
    }

    try {
      const state = await this.store.mutate(reference, (previous) =>
        transitionThreadState(previous, snapshot, explicitMention, this.now()));
      return {
        muted: state?.mode === "muted",
        source: explicitMention ? "mention" : "slack",
        ...(state ? { state } : {}),
      };
    } catch (error) {
      this.logger.error?.(
        `slack-thread-focus: state update failed for ${reference.channelId}:${reference.threadTs} (${String(error)})`,
      );
      const transient = transitionThreadState(undefined, snapshot, explicitMention, this.now());
      return {
        muted: transient?.mode === "muted",
        source: explicitMention ? "mention" : "slack",
        ...(transient ? { state: transient } : {}),
      };
    }
  }

  async requestResume(reference: ThreadReference): Promise<FocusDecision> {
    try {
      const state = await this.store.mutate(reference, (previous) =>
        requestResumeWithoutSnapshot(previous, this.now()));
      return { muted: false, source: "mention", ...(state ? { state } : {}) };
    } catch (error) {
      this.logger.error?.(
        `slack-thread-focus: could not persist mention resume for ${reference.channelId}:${reference.threadTs} (${String(error)})`,
      );
      return { muted: false, source: "mention" };
    }
  }

  private async evaluateStored(
    reference: ThreadReference,
    explicitMention: boolean,
  ): Promise<FocusDecision> {
    try {
      const state = await this.store.mutate(reference, (previous) =>
        explicitMention ? requestResumeWithoutSnapshot(previous, this.now()) : previous);
      return {
        muted: explicitMention ? false : state?.mode === "muted",
        source: explicitMention ? "mention" : (state ? "stored" : "fail-open"),
        ...(state ? { state } : {}),
      };
    } catch (error) {
      this.logger.error?.(
        `slack-thread-focus: stored-state lookup failed for ${reference.channelId}:${reference.threadTs} (${String(error)})`,
      );
      return { muted: false, source: explicitMention ? "mention" : "fail-open" };
    }
  }

  private readSnapshot(
    reference: ThreadReference,
    forceRefresh: boolean,
  ): Promise<ReactionSnapshot | undefined> {
    if (!this.reactions) {
      return Promise.resolve(undefined);
    }
    const key = `${reference.accountId}:${reference.channelId}:${reference.threadTs}`;
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && this.now() - cached.fetchedAt <= this.cacheTtlMs) {
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const request = this.reactions.getSnapshot(reference.channelId, reference.threadTs)
      .then((snapshot) => {
        this.cache.set(key, snapshot);
        return snapshot;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }
}
