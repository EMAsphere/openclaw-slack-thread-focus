import type { ReactionSnapshot } from "./types.js";

type SlackApiResponse = {
  ok?: unknown;
  error?: unknown;
};

type SlackReaction = {
  name?: unknown;
  count?: unknown;
  users?: unknown;
};

type SlackReactionsResponse = SlackApiResponse & {
  message?: {
    reactions?: unknown;
  };
};

type SlackAuthResponse = SlackApiResponse & {
  user_id?: unknown;
};

type SlackRepliesResponse = SlackApiResponse & {
  messages?: unknown;
};

type SlackMessage = {
  ts?: unknown;
  text?: unknown;
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
  botUserId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class SlackReactionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private botUserIdPromise: Promise<string> | undefined;

  constructor(private readonly options: SlackReactionClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async getSnapshot(channelId: string, threadTs: string): Promise<ReactionSnapshot> {
    const payload = await this.request<SlackReactionsResponse>("reactions.get", {
      channel: channelId,
      timestamp: threadTs,
      full: "true",
    });
    const reactions = Array.isArray(payload.message?.reactions)
      ? payload.message.reactions as SlackReaction[]
      : [];
    return {
      muteCount: reactionCount(reactions, this.options.muteEmoji),
      resumeCount: reactionCount(reactions, this.options.resumeEmoji),
      fetchedAt: this.now(),
    };
  }

  async hasExplicitBotMention(
    channelId: string,
    threadTs: string,
    messageTs: string,
  ): Promise<boolean> {
    const [botUserId, payload] = await Promise.all([
      this.getBotUserId(),
      this.request<SlackRepliesResponse>("conversations.replies", {
        channel: channelId,
        ts: threadTs,
        oldest: messageTs,
        latest: messageTs,
        inclusive: "true",
        limit: "1",
      }),
    ]);
    const messages = Array.isArray(payload.messages) ? payload.messages as SlackMessage[] : [];
    const message = messages.find((candidate) => candidate.ts === messageTs);
    const rawText = typeof message?.text === "string" ? message.text : "";
    return rawText.includes(`<@${botUserId}>`) || rawText.includes(`<@${botUserId}|`);
  }

  async warmupIdentity(): Promise<void> {
    await this.getBotUserId();
  }

  private getBotUserId(): Promise<string> {
    const configured = this.options.botUserId?.trim();
    if (configured) {
      return Promise.resolve(configured);
    }
    if (this.botUserIdPromise) {
      return this.botUserIdPromise;
    }

    const request = this.request<SlackAuthResponse>("auth.test", {}).then((payload) => {
      if (typeof payload.user_id !== "string" || !payload.user_id.trim()) {
        throw new SlackReactionError("Slack auth.test did not return user_id", "missing_user_id");
      }
      return payload.user_id.trim();
    });
    this.botUserIdPromise = request;
    void request.catch(() => {
      if (this.botUserIdPromise === request) {
        this.botUserIdPromise = undefined;
      }
    });
    return request;
  }

  private async request<T extends SlackApiResponse>(
    method: string,
    parameters: Record<string, string>,
  ): Promise<T> {
    const query = new URLSearchParams(parameters);
    const suffix = query.size > 0 ? `?${query}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`https://slack.com/api/${method}${suffix}`, {
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
      throw new SlackReactionError(`Slack ${method} failed: ${String(error)}`, code);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "0");
      throw new SlackReactionError(
        `Slack ${method} was rate limited`,
        "ratelimited",
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
      );
    }
    if (!response.ok) {
      throw new SlackReactionError(
        `Slack ${method} returned HTTP ${response.status}`,
        `http_${response.status}`,
      );
    }

    const payload = await response.json() as T;
    if (payload.ok !== true) {
      const code = typeof payload.error === "string" ? payload.error : "unknown_error";
      throw new SlackReactionError(`Slack ${method} returned ${code}`, code);
    }
    return payload;
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
