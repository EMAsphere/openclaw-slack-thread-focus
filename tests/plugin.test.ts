import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSlackThreadFocus } from "../src/plugin.js";

type Hook = (event: never, context: never) => Promise<unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function registerPlugin(fetchOverride?: typeof fetch, extra: Record<string, unknown> = {}, muteEmoji = "no_bell"): Promise<Map<string, Hook>> {
  const directory = await mkdtemp(join(tmpdir(), "thread-focus-plugin-"));
  const hooks = new Map<string, Hook>();
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("SLACK_BOT_USER_ID", "USERGIO");
  const defaultFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/conversations.replies?")) {
      return new Response(JSON.stringify({
        ok: true,
        messages: [{ ts: "1712.0002", text: "<@USERGIO> reviens" }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      ok: true,
      message: { reactions: [{ name: muteEmoji, count: 1 }] },
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchOverride ?? defaultFetch);

  const api = {
    config: { agents: { list: [{ id: "main", name: "Sergio", default: true }] } },
    pluginConfig: {},
    logger: {},
    runtime: {
      state: { resolveStateDir: () => directory },
      config: {
        current: () => ({ agents: { list: [{ id: "main", name: "Sergio", default: true }] } }),
      },
    },
    on: (name: string, handler: Hook) => hooks.set(name, handler),
    ...extra,
  } as unknown as OpenClawPluginApi;
  registerSlackThreadFocus(api);
  return hooks;
}

describe("OpenClaw hooks", () => {
  it("keeps progress opt-in and preserves the outgoing focus gate", async () => {
    const register = vi.fn();
    const hooks = await registerPlugin(undefined, { agent: { events: { registerAgentEventSubscription: register } } });
    expect(register).not.toHaveBeenCalled();
    expect(hooks.has("message_sending")).toBe(true);
    expect(hooks.has("before_agent_reply")).toBe(false);
  });

  it("declares the same progress capabilities during credential-free CLI setup", async () => {
    const register = vi.fn();
    const lifecycle = vi.fn();
    const hooks = await registerPlugin(undefined, {
      pluginConfig: { progressCards: true, botTokenEnv: "UNSET_THREAD_FOCUS_TEST_TOKEN" },
      agent: { events: { registerAgentEventSubscription: register } },
      lifecycle: { registerRuntimeLifecycle: lifecycle },
    });
    expect(register).toHaveBeenCalledOnce();
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(hooks.has("before_agent_reply")).toBe(true);
    expect(hooks.has("message_sending")).toBe(true);
  });

  it.each(["default", "sergio"])("correlates %s account hooks to progress and waits for a pending mention before posting", async (accountId) => {
    vi.useFakeTimers();
    let releaseReplies!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("conversations.replies")) return new Promise<Response>((resolve) => { releaseReplies = resolve; });
      if (url.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "1712.0009" }));
      return new Response(JSON.stringify({ ok: true, message: { reactions: [{ name: "no_bell", count: 1 }] } }));
    });
    type Subscription = { handle(event: Record<string, unknown>): void };
    let subscription!: Subscription;
    let cleanup!: { cleanup(context: object): void };
    try {
      const hooks = await registerPlugin(fetchImpl, {
        pluginConfig: { progressCards: true, accountId },
        agent: { events: { registerAgentEventSubscription: (value: Subscription) => { subscription = value; } } },
        lifecycle: { registerRuntimeLifecycle: (value: typeof cleanup) => { cleanup = value; } },
      });
      const sessionKey = "agent:main:slack:channel:c123:thread:1712.0001";
      const received = hooks.get("message_received")!({
        from: "slack:C123", content: "reviens", messageId: "1712.0002", threadId: "1712.0001", sessionKey,
      } as never, { channelId: "slack", accountId, conversationId: "C123", sessionKey } as never);
      await hooks.get("before_agent_reply")!({} as never, { sessionKey, trigger: "user" } as never);
      subscription.handle({ runId: "r1", seq: 1, stream: "tool", sessionKey, ts: Date.now(),
        data: { phase: "start", toolCallId: "t1", name: "exec" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("chat.postMessage"))).toBe(false);
      releaseReplies(new Response(JSON.stringify({ ok: true, messages: [{ ts: "1712.0002", text: "<@USERGIO> reviens" }] })));
      await received;
      await vi.waitFor(() => {
        expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("chat.postMessage"))).toHaveLength(1);
      });
      cleanup.cleanup({});
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["roger", "fabrice", "maurice", undefined])("ignores %s account hooks when the token belongs to Sergio", async (accountId) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      ok: true, message: { reactions: [{ name: "mute", count: 1 }] },
    })));
    const hooks = await registerPlugin(fetchImpl, { pluginConfig: { accountId: "sergio" } });
    const context = { channelId: "slack", accountId, conversationId: "C123", sessionKey: "agent:main:slack:channel:c123:thread:1712.0001" };
    const event = { channel: "slack", content: "@Sergio", to: "C123", threadId: "1712.0001", messageId: "1712.0002" };
    for (const hook of ["message_received", "inbound_claim", "message_sending"]) {
      await expect(hooks.get(hook)!(event as never, context as never)).resolves.toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    // The same token still enforces focus for its own account.
    await expect(hooks.get("message_sending")!(event as never, { ...context, accountId: "sergio" } as never))
      .resolves.toMatchObject({ cancel: true });
  });
  it("claims a muted inbound message before the model and lets a mention resume", async () => {
    const hooks = await registerPlugin();
    const inbound = hooks.get("inbound_claim")!;
    const event = {
      content: "follow-up",
      channel: "slack",
      accountId: "default",
      conversationId: "C123",
      threadId: "1712.0001",
      sessionKey: "agent:main:slack:channel:C123:thread:1712.0001",
      isGroup: true,
      wasMentioned: false,
    };
    const context = {
      channelId: "slack",
      accountId: "default",
      conversationId: "C123",
      sessionKey: event.sessionKey,
    };

    await expect(inbound(event as never, context as never)).resolves.toEqual({ handled: true });
    await expect(inbound({ ...event, wasMentioned: true } as never, context as never))
      .resolves.toBeUndefined();
    await expect(inbound(event as never, context as never)).resolves.toBeUndefined();
  });

  it.each(["no_bell", "mute"])("cancels a reply with %s, then lets message_received persist an explicit mention resume", async (muteEmoji) => {
    const hooks = await registerPlugin(undefined, {}, muteEmoji);
    const outgoing = hooks.get("message_sending")!;
    const outgoingEvent = {
      to: "C123",
      content: "reply",
      replyToId: "1712.0001",
    };
    const context = {
      channelId: "slack",
      accountId: "default",
      conversationId: "C123",
      sessionKey: "agent:main:slack:channel:C123:thread:1712.0001",
    };
    await expect(outgoing(outgoingEvent as never, context as never)).resolves.toEqual({
      cancel: true,
      cancelReason: "slack_thread_muted",
    });

    const received = hooks.get("message_received")!;
    await received({
      from: "slack:C123",
      content: "reviens",
      messageId: "1712.0002",
      threadId: "1712.0001",
      sessionKey: context.sessionKey,
      metadata: { messageId: "1712.0002" },
    } as never, context as never);

    await expect(outgoing(outgoingEvent as never, context as never)).resolves.toBeUndefined();
  });

  it("waits for an in-flight message_received mention check before sending", async () => {
    let releaseReplies: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("/conversations.replies?")) {
        return new Promise<Response>((resolve) => {
          releaseReplies = resolve;
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        message: { reactions: [{ name: "no_bell", count: 1 }] },
      }), { status: 200 });
    });
    const hooks = await registerPlugin(fetchImpl);
    const context = {
      channelId: "slack",
      accountId: "default",
      conversationId: "C123",
      sessionKey: "agent:main:slack:channel:C123:thread:1712.0001",
    };
    const receivedPromise = hooks.get("message_received")!({
      from: "slack:C123",
      content: "reviens",
      messageId: "1712.0002",
      threadId: "1712.0001",
      sessionKey: context.sessionKey,
    } as never, context as never);
    const outgoingPromise = hooks.get("message_sending")!({
      to: "C123",
      content: "reply",
      replyToId: "1712.0001",
    } as never, context as never);

    let settled = false;
    void outgoingPromise.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseReplies?.(new Response(JSON.stringify({
      ok: true,
      messages: [{ ts: "1712.0002", text: "<@USERGIO> reviens" }],
    }), { status: 200 }));
    await receivedPromise;
    await expect(outgoingPromise).resolves.toBeUndefined();
  });

  it("keeps mixed mute reactions muted until all are removed, and lets bell resume both", async () => {
    let names = ["no_bell", "mute"];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      ok: true, message: { reactions: names.map((name) => ({ name, count: 1 })) },
    })));
    const hooks = await registerPlugin(fetchImpl);
    const event = { to: "C123", content: "reply", replyToId: "1712.0001" };
    const context = { channelId: "slack", conversationId: "C123" };
    const send = () => hooks.get("message_sending")!(event as never, context as never);
    await expect(send()).resolves.toMatchObject({ cancel: true });
    names = ["mute"];
    await expect(send()).resolves.toMatchObject({ cancel: true });
    names = [];
    await expect(send()).resolves.toBeUndefined();
    names = ["mute"];
    await expect(send()).resolves.toMatchObject({ cancel: true });
    names = ["mute", "bell"];
    await expect(send()).resolves.toBeUndefined();
    names = ["mute", "bell", "no_bell"];
    await expect(send()).resolves.toMatchObject({ cancel: true });
  });
});
