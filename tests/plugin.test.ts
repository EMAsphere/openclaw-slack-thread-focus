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

async function registerPlugin(fetchOverride?: typeof fetch): Promise<Map<string, Hook>> {
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
      message: { reactions: [{ name: "no_bell", count: 1 }] },
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
  } as unknown as OpenClawPluginApi;
  registerSlackThreadFocus(api);
  return hooks;
}

describe("OpenClaw hooks", () => {
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

  it("cancels a muted reply, then lets message_received persist an explicit mention resume", async () => {
    const hooks = await registerPlugin();
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
});
