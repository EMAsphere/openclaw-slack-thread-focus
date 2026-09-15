import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, expect, it, vi } from "vitest";
import { registerSlackThreadFocus } from "../src/plugin.js";
import type { ProgressEvent } from "../src/progress.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(["conversation", "active"])("keeps progress with reply hooks on the %s registry and retirement of another registry", async (replyRegistry) => {
  vi.useFakeTimers();
  vi.stubEnv("SLACK_BOT_TOKEN", "token");
  vi.stubEnv("SLACK_BOT_USER_ID", "UBOT");
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).includes("chat.")) return new Response(JSON.stringify({ ok: true, ts: "1712.0009" }));
    return new Response(JSON.stringify({ ok: true, message: { reactions: [{ name: "mute", count: 1 }] } }));
  });
  vi.stubGlobal("fetch", fetchImpl);
  const directory = await mkdtemp(join(tmpdir(), "thread-focus-registries-"));
  const config = { agents: { list: [{ id: "main", name: "Vivien" }] } };
  const register = () => {
    const hooks = new Map<string, (event: never, context: never) => unknown>();
    let handle!: (event: ProgressEvent) => void;
    let cleanup!: (context: { reason: string }) => void;
    registerSlackThreadFocus({
      version: "test", config, pluginConfig: { progressCards: true }, logger: {},
      runtime: { state: { resolveStateDir: () => directory }, config: { current: () => config } },
      agent: { events: { registerAgentEventSubscription: (subscription: { handle: typeof handle }) => { handle = subscription.handle; } } },
      lifecycle: { registerRuntimeLifecycle: (lifecycle: { cleanup: typeof cleanup }) => { cleanup = lifecycle.cleanup; } },
      on: (name: string, hook: (event: never, context: never) => unknown) => hooks.set(name, hook),
    } as unknown as OpenClawPluginApi);
    return { hooks, handle, cleanup };
  };
  // OpenClaw 2026.9.2 uses scoped registries for hooks, but the active registry for agent events.
  const conversation = register();
  const active = register();
  const sessionKey = "agent:main:slack:channel:c123:thread:1712.0001";
  try {
    await conversation.hooks.get("message_received")!({ content: "@Vivien", threadId: "1712.0001", sessionKey } as never,
      { channelId: "slack", conversationId: "C123", sessionKey } as never);
    await (replyRegistry === "conversation" ? conversation : active).hooks.get("before_agent_reply")!({} as never,
      { sessionKey, trigger: "user" } as never);
    active.handle({ runId: "run1", seq: 1, stream: "tool", sessionKey, ts: Date.now(),
      data: { phase: "start", toolCallId: "tool1", name: "exec" } });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("chat.postMessage"))).toHaveLength(1));

    conversation.cleanup({ reason: "restart" });
    active.handle({ runId: "run1", seq: 2, stream: "lifecycle", sessionKey, ts: Date.now(), data: { phase: "end" } });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("chat.update"))).toHaveLength(1));
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("chat.postMessage"))).toHaveLength(1);
  } finally {
    conversation.cleanup({ reason: "restart" });
    active.cleanup({ reason: "restart" });
  }
});
