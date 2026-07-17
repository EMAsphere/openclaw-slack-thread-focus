import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePluginConfig } from "./config.js";
import { ThreadFocusController } from "./controller.js";
import { containsAgentNameMention } from "./mention.js";
import { resolveInboundReference, resolveOutboundReference } from "./routing.js";
import { SlackReactionClient } from "./slack.js";
import { JsonThreadStateStore } from "./store.js";
import type { ThreadReference } from "./types.js";

function resolveDefaultAgentId(api: OpenClawPluginApi): string {
  const agents = api.config.agents?.list;
  if (Array.isArray(agents)) {
    const selected = agents.find((agent) => agent?.default === true) ?? agents[0];
    if (selected?.id) {
      return selected.id;
    }
  }
  return process.env.OPENCLAW_AGENT_ID || "main";
}

function fallbackStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
}

function resolveAgentMentionNames(api: OpenClawPluginApi, agentId: string): string[] {
  const current = api.runtime.config.current();
  const agents = current.agents?.list;
  if (!Array.isArray(agents)) {
    return [];
  }
  const selected = agents.find((agent) => agent?.id === agentId);
  const candidates = [selected?.identity?.name, selected?.name];
  const names = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }
    const normalized = candidate.trim();
    names.add(normalized);
    const baseName = normalized.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (baseName) {
      names.add(baseName);
    }
  }
  return [...names];
}

function pendingKey(reference: ThreadReference): string {
  return JSON.stringify([
    reference.agentId,
    reference.accountId,
    reference.channelId,
    reference.threadTs,
  ]);
}

function optionalText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function registerSlackThreadFocus(api: OpenClawPluginApi): void {
  const config = resolvePluginConfig(api.pluginConfig);
  const token = process.env[config.botTokenEnv]?.trim();
  const botUserId = process.env[config.botUserIdEnv]?.trim();
  const stateDir = api.runtime.state.resolveStateDir(process.env) || fallbackStateDir();
  const store = new JsonThreadStateStore(
    join(stateDir, "plugins", "slack-thread-focus", "state.json"),
    config.stateTtlDays * 24 * 60 * 60 * 1000,
  );
  const reactions = token
    ? new SlackReactionClient({
        token,
        muteEmoji: config.muteEmoji,
        resumeEmoji: config.resumeEmoji,
        timeoutMs: config.apiTimeoutMs,
        ...(botUserId ? { botUserId } : {}),
      })
    : undefined;
  const controller = new ThreadFocusController(
    store,
    reactions,
    config.cacheTtlMs,
    api.logger,
  );
  const defaultAgentId = resolveDefaultAgentId(api);
  const pendingMentionChecks = new Map<string, Set<Promise<void>>>();

  if (!token) {
    api.logger.warn?.(
      `slack-thread-focus: ${config.botTokenEnv} is not set; using persisted state and failing open for unknown threads`,
    );
  } else {
    void reactions?.warmupIdentity().catch((error) => {
      api.logger.warn?.(`slack-thread-focus: could not pre-resolve Slack bot identity (${String(error)})`);
    });
  }

  api.on("message_received", async (event, context) => {
    if (context.channelId !== "slack") {
      return;
    }
    const reference = resolveInboundReference({
      ...(config.agentId ? { configuredAgentId: config.agentId } : {}),
      defaultAgentId,
      event,
      context,
    });
    if (!reference) {
      return;
    }

    const key = pendingKey(reference);
    const messageTs = optionalText(event.messageId) || optionalText(event.metadata?.messageId);
    const check = (async () => {
      let explicitlyMentioned = containsAgentNameMention(
        event.content,
        resolveAgentMentionNames(api, reference.agentId),
      );
      if (!explicitlyMentioned && reactions && messageTs) {
        explicitlyMentioned = await reactions.hasExplicitBotMention(
          reference.channelId,
          reference.threadTs,
          messageTs,
        );
      }
      if (!explicitlyMentioned) {
        return;
      }

      await controller.requestResume(reference);
      api.logger.info?.(
        `slack-thread-focus: resumed ${reference.agentId} from message_received in ${reference.channelId}:${reference.threadTs}`,
      );
    })().catch((error) => {
      api.logger.warn?.(
        `slack-thread-focus: explicit-mention check failed for ${reference.channelId}:${reference.threadTs} (${String(error)})`,
      );
    });

    const checks = pendingMentionChecks.get(key) ?? new Set<Promise<void>>();
    checks.add(check);
    pendingMentionChecks.set(key, checks);
    await check;
    checks.delete(check);
    if (checks.size === 0 && pendingMentionChecks.get(key) === checks) {
      pendingMentionChecks.delete(key);
    }
  });

  api.on("inbound_claim", async (event, context) => {
    if (event.channel !== "slack" && context.channelId !== "slack") {
      return;
    }
    const reference = resolveInboundReference({
      ...(config.agentId ? { configuredAgentId: config.agentId } : {}),
      defaultAgentId,
      event,
      context,
    });
    if (!reference) {
      return;
    }

    const explicitMention = event.wasMentioned === true;
    const decision = await controller.evaluate(reference, explicitMention, true);
    if (explicitMention) {
      api.logger.info?.(
        `slack-thread-focus: resumed ${reference.agentId} in ${reference.channelId}:${reference.threadTs}`,
      );
      return;
    }
    if (decision.muted) {
      api.logger.info?.(
        `slack-thread-focus: silently ignored ${reference.channelId}:${reference.threadTs} (${decision.source})`,
      );
      return { handled: true };
    }
    return;
  });

  api.on("message_sending", async (event, context) => {
    if (context.channelId !== "slack") {
      return;
    }
    const reference = resolveOutboundReference({
      ...(config.agentId ? { configuredAgentId: config.agentId } : {}),
      defaultAgentId,
      event,
      context,
    });
    if (!reference) {
      return;
    }
    const checks = pendingMentionChecks.get(pendingKey(reference));
    if (checks) {
      await Promise.all([...checks]);
    }
    const decision = await controller.evaluate(reference, false, true);
    if (!decision.muted) {
      return;
    }
    api.logger.info?.(
      `slack-thread-focus: cancelled outgoing message to ${reference.channelId}:${reference.threadTs}`,
    );
    return { cancel: true, cancelReason: "slack_thread_muted" };
  });
}
