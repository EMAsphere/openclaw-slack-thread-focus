import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePluginConfig } from "./config.js";
import { ThreadFocusController } from "./controller.js";
import { resolveInboundReference, resolveOutboundReference } from "./routing.js";
import { SlackReactionClient } from "./slack.js";
import { JsonThreadStateStore } from "./store.js";

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

export function registerSlackThreadFocus(api: OpenClawPluginApi): void {
  const config = resolvePluginConfig(api.pluginConfig);
  const token = process.env[config.botTokenEnv]?.trim();
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
      })
    : undefined;
  const controller = new ThreadFocusController(
    store,
    reactions,
    config.cacheTtlMs,
    api.logger,
  );
  const defaultAgentId = resolveDefaultAgentId(api);

  if (!token) {
    api.logger.warn?.(
      `slack-thread-focus: ${config.botTokenEnv} is not set; using persisted state and failing open for unknown threads`,
    );
  }

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
