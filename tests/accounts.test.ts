import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, expect, it, vi } from "vitest";
import { registerSlackThreadFocus } from "../src/plugin.js";
import type { ProgressEvent } from "../src/progress.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("routes every agent through its own Slack credentials across registries", async () => {
  vi.useFakeTimers();
  const accounts = ["sergio", "roger", "fabrice", "maurice"];
  for (const account of accounts) vi.stubEnv(`${account.toUpperCase()}_SLACK_BOT_TOKEN`, account);
  // A global bot identity must not override the identities of named accounts.
  vi.stubEnv("SLACK_BOT_USER_ID", "WRONG_BOT");
  const writes: { method: string; account: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
    const account = new Headers(options?.headers).get("Authorization")!.replace("Bearer ", "");
    const url = new URL(String(input));
    if (url.pathname.endsWith("auth.test")) return new Response(JSON.stringify({ ok: true, user_id: `U${account}` }));
    if (url.pathname.includes("chat.")) {
      const body = JSON.parse(String(options?.body));
      writes.push({ method: url.pathname.split("/").at(-1)!, account, body });
      return new Response(JSON.stringify({ ok: true, ts: `1712.${writes.length}` }));
    }
    if (url.pathname.endsWith("conversations.replies")) {
      return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1712.0002", text: `<@U${account}>` }] }));
    }
    return new Response(JSON.stringify({ ok: true, message: { reactions: [{ name: "mute", count: 1 }] } }));
  });
  vi.stubGlobal("fetch", fetchImpl);
  const directory = await mkdtemp(join(tmpdir(), "thread-focus-accounts-"));
  type Hook = (event: never, context: never) => unknown;
  const register = () => {
    const hooks = new Map<string, Hook[]>();
    const subscriptions = new Map<string, (event: ProgressEvent) => void>();
    const cleanups = new Map<string, (context: object) => void>();
    registerSlackThreadFocus({
      version: "test", config: {}, logger: {},
      pluginConfig: { progressCards: true, accounts: Object.fromEntries(accounts.map(account => [account, { botTokenEnv: `${account.toUpperCase()}_SLACK_BOT_TOKEN` }])) },
      runtime: { state: { resolveStateDir: () => directory }, config: { current: () => ({}) } },
      agent: { events: { registerAgentEventSubscription: (s: { id: string; handle: (event: ProgressEvent) => void }) => {
        expect(subscriptions.has(s.id)).toBe(false); subscriptions.set(s.id, s.handle);
      } } },
      lifecycle: { registerRuntimeLifecycle: (l: { id: string; cleanup: (context: object) => void }) => {
        expect(cleanups.has(l.id)).toBe(false); cleanups.set(l.id, l.cleanup);
      } },
      on: (name: string, hook: Hook) => hooks.set(name, [...(hooks.get(name) ?? []), hook]),
    } as unknown as OpenClawPluginApi);
    return {
      hook: (name: string, event: object, context: object) => Promise.all((hooks.get(name) ?? []).map(hook => hook(event as never, context as never))),
      event: (event: ProgressEvent) => { for (const handle of subscriptions.values()) handle(event); },
      cleanup: () => { for (const cleanup of cleanups.values()) cleanup({ reason: "restart" }); },
    };
  };
  const conversation = register();
  const active = register();
  const agents = ["default", "refresh-preprod", "previews", "hydra-etl", "roger", "fabrice", "maurice"];
  const runs = agents.map(agentId => ({
    agentId, accountId: accounts.includes(agentId) ? agentId : "sergio",
    sessionKey: `agent:${agentId}:slack:channel:c123:thread:1712.0001`,
  }));
  try {
    for (const run of runs) {
      await conversation.hook("message_received", { content: "test", messageId: "1712.0002", threadId: "1712.0001", sessionKey: run.sessionKey },
        { channelId: "slack", conversationId: "C123", accountId: run.accountId });
      await active.hook("before_agent_reply", {}, { sessionKey: run.sessionKey, trigger: "user" });
      active.event({ runId: run.agentId, seq: 1, stream: "tool", agentId: run.agentId, sessionKey: run.sessionKey, ts: Date.now(), data: { phase: "start", name: run.agentId, toolCallId: "tool1" } });
    }
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(writes.filter(w => w.method === "chat.postMessage")).toHaveLength(runs.length));
    for (const run of runs) {
      const post = writes.find(w => JSON.stringify(w.body).includes(run.agentId));
      expect(post?.account).toBe(run.accountId);
      expect(post?.body.thread_ts).toBe("1712.0001");
    }
    conversation.cleanup();
    for (const run of runs) active.event({ runId: run.agentId, seq: 2, stream: "lifecycle", sessionKey: run.sessionKey, ts: Date.now(), data: { phase: "end" } });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(writes.filter(w => w.method === "chat.update")).toHaveLength(runs.length));
    expect(await readdir(join(directory, "plugins", "slack-thread-focus"))).toEqual(accounts.map(a => `state-${a}.json`).sort());
  } finally { conversation.cleanup(); active.cleanup(); }
});
