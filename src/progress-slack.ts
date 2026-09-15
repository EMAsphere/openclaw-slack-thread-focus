import type { ThreadReference } from "./types.js";

export type ProgressCard = { text: string; blocks: unknown[] };

export interface ProgressTransport {
  post(reference: ThreadReference, card: ProgressCard): Promise<string>;
  update(reference: ThreadReference, ts: string, card: ProgressCard): Promise<void>;
  remove(reference: ThreadReference, ts: string): Promise<void>;
}

/** Writes only plugin-owned messages; never retries an ambiguous post. */
export class SlackProgressClient implements ProgressTransport {
  constructor(
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async post(reference: ThreadReference, card: ProgressCard): Promise<string> {
    const result = await this.request("chat.postMessage", {
      channel: reference.channelId, thread_ts: reference.threadTs,
      ...card, unfurl_links: false, unfurl_media: false, parse: "none",
    });
    if (typeof result.ts !== "string" || !/^\d+\.\d+$/.test(result.ts)) {
      throw new Error("Slack chat.postMessage returned no message timestamp");
    }
    return result.ts;
  }

  async update(reference: ThreadReference, ts: string, card: ProgressCard): Promise<void> {
    await this.request("chat.update", { channel: reference.channelId, ts, ...card, parse: "none" });
  }

  async remove(reference: ThreadReference, ts: string): Promise<void> {
    await this.request("chat.delete", { channel: reference.channelId, ts });
  }

  private async request(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Slack ${method}: HTTP ${response.status}`);
      const result = await response.json() as Record<string, unknown>;
      if (result.ok !== true) {
        const code = typeof result.error === "string" && /^[a-z_]+$/.test(result.error)
          ? result.error : "api_error";
        throw new Error(`Slack ${method}: ${code}`);
      }
      return result;
    } catch (error) {
      // Do not include a fetch implementation's error text (it can contain credentials).
      if (error instanceof Error && error.message.startsWith(`Slack ${method}:`)) throw error;
      throw new Error(`Slack ${method}: transport_error`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
