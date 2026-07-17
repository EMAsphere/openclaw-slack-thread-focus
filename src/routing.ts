import type { ThreadReference } from "./types.js";

type Metadata = Record<string, unknown> | undefined;

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function normalizeSlackChannelId(value: unknown): string {
  const raw = text(value);
  if (!raw) {
    return "";
  }
  const match = /^(?:slack:)?channel:(.+)$/i.exec(raw);
  return (match?.[1] ?? raw).trim();
}

export function resolveAgentId(params: {
  configuredAgentId?: string;
  sessionKey?: unknown;
  contextAgentId?: unknown;
  defaultAgentId?: string;
}): string {
  if (params.configuredAgentId) {
    return params.configuredAgentId;
  }
  const sessionKey = text(params.sessionKey);
  const sessionMatch = /^agent:([^:]+):/i.exec(sessionKey);
  return sessionMatch?.[1] || text(params.contextAgentId) || params.defaultAgentId || "main";
}

export function threadFromSessionKey(value: unknown): string {
  const sessionKey = text(value);
  const match = /:thread:([^:]+)$/i.exec(sessionKey);
  return match?.[1] ?? "";
}

export function resolveInboundReference(params: {
  configuredAgentId?: string;
  defaultAgentId?: string;
  event: {
    accountId?: string;
    conversationId?: string;
    threadId?: string | number;
    replyToId?: string;
    messageId?: string;
    sessionKey?: string;
    metadata?: Metadata;
  };
  context: {
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    agentId?: string;
  };
}): ThreadReference | undefined {
  const { event, context } = params;
  const threadTs = text(event.threadId) || text(event.metadata?.threadTs) ||
    text(event.metadata?.threadId) || text(event.replyToId) ||
    threadFromSessionKey(event.sessionKey ?? context.sessionKey) || text(event.messageId);
  const channelId = normalizeSlackChannelId(event.conversationId) ||
    normalizeSlackChannelId(context.conversationId) ||
    normalizeSlackChannelId(event.metadata?.channelId);
  if (!threadTs || !channelId) {
    return undefined;
  }
  return {
    agentId: resolveAgentId({
      ...(params.configuredAgentId ? { configuredAgentId: params.configuredAgentId } : {}),
      sessionKey: event.sessionKey ?? context.sessionKey,
      contextAgentId: context.agentId,
      ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    }),
    accountId: event.accountId || context.accountId || "default",
    channelId,
    threadTs,
  };
}

export function resolveOutboundReference(params: {
  configuredAgentId?: string;
  defaultAgentId?: string;
  event: {
    to?: string;
    threadId?: string | number;
    replyToId?: string | number;
    metadata?: Metadata;
  };
  context: {
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
  };
}): ThreadReference | undefined {
  const { event, context } = params;
  const threadTs = text(event.replyToId) || text(event.threadId) ||
    text(event.metadata?.threadTs) || text(event.metadata?.threadId) ||
    threadFromSessionKey(context.sessionKey);
  const channelId = normalizeSlackChannelId(context.conversationId) ||
    normalizeSlackChannelId(event.metadata?.channelId) || normalizeSlackChannelId(event.to);
  if (!threadTs || !channelId) {
    return undefined;
  }
  return {
    agentId: resolveAgentId({
      ...(params.configuredAgentId ? { configuredAgentId: params.configuredAgentId } : {}),
      sessionKey: context.sessionKey,
      ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    }),
    accountId: context.accountId || text(event.metadata?.accountId) || "default",
    channelId,
    threadTs,
  };
}
