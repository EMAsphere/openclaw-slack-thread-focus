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

async function registerPlugin(): Promise<Map<string, Hook>> {
  const directory = await mkdtemp(join(tmpdir(), "thread-focus-plugin-"));
  const hooks = new Map<string, Hook>();
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    ok: true,
    message: { reactions: [{ name: "no_bell", count: 1 }] },
  }), { status: 200 })));

  const api = {
    config: {},
    pluginConfig: {},
    logger: {},
    runtime: {
      state: { resolveStateDir: () => directory },
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

  it("cancels an outgoing Slack reply when the root is muted", async () => {
    const hooks = await registerPlugin();
    const outgoing = hooks.get("message_sending")!;
    await expect(outgoing({
      to: "C123",
      content: "reply",
      replyToId: "1712.0001",
    } as never, {
      channelId: "slack",
      accountId: "default",
      conversationId: "C123",
      sessionKey: "agent:main:slack:channel:C123:thread:1712.0001",
    } as never)).resolves.toEqual({
      cancel: true,
      cancelReason: "slack_thread_muted",
    });
  });
});
