import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressCards, type ProgressEvent } from "../src/progress.js";
import { SlackProgressClient, type ProgressTransport } from "../src/progress-slack.js";
import type { FocusDecision } from "../src/types.js";

const sessionKey = "agent:main:slack:channel:c123:thread:1712.0001";
const reference = { agentId: "main", accountId: "default", channelId: "C123", threadTs: "1712.0001" };
const active: FocusDecision = { muted: false, source: "slack" };
const muted: FocusDecision = { muted: true, source: "slack" };

function setup() {
  vi.useFakeTimers();
  const transport = {
    post: vi.fn<ProgressTransport["post"]>().mockResolvedValue("1712.0009"),
    update: vi.fn<ProgressTransport["update"]>().mockResolvedValue(),
    remove: vi.fn<ProgressTransport["remove"]>().mockResolvedValue(),
  };
  const check = vi.fn<() => Promise<FocusDecision>>().mockResolvedValue(active);
  const cards = new ProgressCards(transport, check, {}, "default");
  cards.rememberInbound(sessionKey, reference);
  cards.authorizeReply(sessionKey, "user");
  let seq = 0;
  function event(stream: string, data: Record<string, unknown>, extra: Partial<ProgressEvent> = {}) {
    cards.handle({ runId: "r1", seq: ++seq, stream, data, ts: Date.now(), sessionKey, ...extra });
  }
  return { cards, transport, check, event };
}
afterEach(() => vi.useRealTimers());

describe("focus-aware progress cards", () => {
  it("posts on first tool, coalesces edits and finishes the same card without exposing tool data", async () => {
    const { transport, event, check } = setup();
    event("lifecycle", { phase: "start" });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.post).not.toHaveBeenCalled();
    event("tool", { phase: "start", toolCallId: "t1", name: "exec", args: { token: "SECRET" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.post).toHaveBeenCalledTimes(1);
    event("tool", { phase: "result", toolCallId: "t1", name: "exec", result: "SECRET" });
    event("tool", { phase: "start", toolCallId: "t2", name: "read" });
    event("tool", { phase: "result", toolCallId: "t2", name: "read" });
    event("lifecycle", { phase: "end" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(transport.update).toHaveBeenCalledTimes(1);
    expect(transport.update.mock.calls[0]?.[1]).toBe("1712.0009");
    expect(JSON.stringify(transport.update.mock.calls)).toContain("Terminé");
    expect(JSON.stringify(transport.post.mock.calls)).not.toContain("SECRET");
    expect(JSON.stringify(transport.update.mock.calls)).not.toContain("SECRET");
    expect(check).toHaveBeenCalledTimes(2);
    // Duplicate/late terminal events cannot create a second card.
    event("lifecycle", { phase: "end" });
    await vi.runAllTimersAsync();
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("does not publish in a muted thread or resume it from progress events", async () => {
    const { check, event, transport } = setup();
    check.mockResolvedValue(muted);
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    await vi.advanceTimersByTimeAsync(0);
    event("tool", { phase: "result", toolCallId: "t1", name: "exec" });
    await vi.runAllTimersAsync();
    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.update).not.toHaveBeenCalled();
  });

  it("deletes its own existing card when a fresh check observes a mute", async () => {
    const { check, event, transport } = setup();
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    await vi.advanceTimersByTimeAsync(0);
    check.mockResolvedValue(muted);
    event("lifecycle", { phase: "end" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(transport.remove).toHaveBeenCalledWith(reference, "1712.0009");
    expect(transport.update).not.toHaveBeenCalled();
  });

  it("requires fresh inbound + user turn authorization, and isolates sessions and accounts", async () => {
    const { cards, event, transport } = setup();
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" }, { sessionKey: "agent:main:cron:job" });
    cards.authorizeReply(sessionKey, "heartbeat");
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    cards.rememberInbound(sessionKey, { ...reference, accountId: "other" });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.post).not.toHaveBeenCalled();
    cards.cleanup();
    cards.rememberInbound(sessionKey, { ...reference, accountId: "other" });
    cards.authorizeReply(sessionKey, "user");
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("expires unused routes and never retries a post whose acknowledgement was lost", async () => {
    const { transport, event, cards } = setup();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.post).not.toHaveBeenCalled();
    cards.rememberInbound(sessionKey, reference);
    cards.authorizeReply(sessionKey, "user");
    transport.post.mockRejectedValue(new Error("timeout"));
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    await vi.advanceTimersByTimeAsync(0);
    event("lifecycle", { phase: "end" });
    await vi.runAllTimersAsync();
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("waits for focus checks, serializes in-flight sends and cancels pending writes on cleanup", async () => {
    const { check, transport, event, cards } = setup();
    let release!: (value: FocusDecision) => void;
    check.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.post).not.toHaveBeenCalled();
    event("lifecycle", { phase: "end" });
    release(active);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.post).toHaveBeenCalledTimes(1);
    cards.cleanup();
    await vi.runAllTimersAsync();
    expect(transport.update).not.toHaveBeenCalled();
  });

  it("uses plain text for plan labels and reports failure without raw errors", async () => {
    const { event, transport } = setup();
    event("plan", { steps: [{ step: "<!channel> deploy", status: "in_progress" }], explanation: "SECRET" });
    await vi.advanceTimersByTimeAsync(0);
    event("lifecycle", { phase: "error", error: "SECRET" });
    await vi.advanceTimersByTimeAsync(1500);
    const card = transport.update.mock.calls[0]?.[2];
    expect(card?.text).toContain("Échec");
    expect(JSON.stringify(card)).not.toContain("mrkdwn");
    expect(JSON.stringify(card)).not.toContain("SECRET");
  });

  it("fails closed for progress when Slack reaction state is unavailable", async () => {
    const { check, event, transport } = setup();
    check.mockResolvedValue({ muted: false, source: "fail-open" });
    event("tool", { phase: "start", toolCallId: "t1", name: "exec" });
    event("lifecycle", { phase: "end" });
    await vi.runAllTimersAsync();
    expect(transport.post).not.toHaveBeenCalled();
  });
});

describe("Slack progress transport", () => {
  it("uses threaded POST requests and keeps auth out of bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: "1712.0009" })));
    const client = new SlackProgressClient("xoxb-secret", 3000, fetchImpl);
    expect(await client.post(reference, { text: "En cours", blocks: [] })).toBe("1712.0009");
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toMatchObject({ channel: "C123", thread_ts: "1712.0001" });
    expect(options?.body).not.toContain("xoxb-secret");
  });

  it("does not retry rate limits or echo transport secrets", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockRejectedValueOnce(new Error("xoxb-secret"));
    const client = new SlackProgressClient("xoxb-secret", 3000, fetchImpl);
    await expect(client.post(reference, { text: "En cours", blocks: [] })).rejects.toThrow("HTTP 429");
    await expect(client.post(reference, { text: "En cours", blocks: [] })).rejects.toThrow("transport_error");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
