import type { ReactionSnapshot } from "./types.js";

type SlackReaction = {
  name?: unknown;
  count?: unknown;
  users?: unknown;
};

type SlackReactionsResponse = {
  ok?: unknown;
  error?: unknown;
  message?: {
    reactions?: unknown;
  };
};

export class SlackReactionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SlackReactionError";
  }
}

export type SlackReactionClientOptions = {
  token: string;
  muteEmoji: string;
  resumeEmoji: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class SlackReactionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: SlackReactionClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async getSnapshot(channelId: string, threadTs: string): Promise<ReactionSnapshot> {
    const query = new URLSearchParams({
      channel: channelId,
      timestamp: threadTs,
      full: "true",
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`https://slack.com/api/reactions.get?${query}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      const code = error instanceof DOMException && error.name === "AbortError"
        ? "timeout"
        : "network_error";
      throw new SlackReactionError(`Slack reactions.get failed: ${String(error)}`, code);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "0");
      throw new SlackReactionError(
        "Slack reactions.get was rate limited",
        "ratelimited",
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
      );
    }
    if (!response.ok) {
      throw new SlackReactionError(
        `Slack reactions.get returned HTTP ${response.status}`,
        `http_${response.status}`,
      );
    }

    const payload = await response.json() as SlackReactionsResponse;
    if (payload.ok !== true) {
      const code = typeof payload.error === "string" ? payload.error : "unknown_error";
      throw new SlackReactionError(`Slack reactions.get returned ${code}`, code);
    }

    const reactions = Array.isArray(payload.message?.reactions)
      ? payload.message.reactions as SlackReaction[]
      : [];
    return {
      muteCount: reactionCount(reactions, this.options.muteEmoji),
      resumeCount: reactionCount(reactions, this.options.resumeEmoji),
      fetchedAt: this.now(),
    };
  }
}

function reactionCount(reactions: SlackReaction[], name: string): number {
  const reaction = reactions.find((candidate) => candidate.name === name);
  if (!reaction) {
    return 0;
  }
  if (typeof reaction.count === "number" && Number.isFinite(reaction.count)) {
    return Math.max(0, Math.trunc(reaction.count));
  }
  return Array.isArray(reaction.users) ? reaction.users.length : 0;
}
