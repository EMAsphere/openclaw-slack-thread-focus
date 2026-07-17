import type { PluginConfig } from "./types.js";

const DEFAULT_CONFIG: PluginConfig = {
  muteEmoji: "no_bell",
  resumeEmoji: "bell",
  botTokenEnv: "SLACK_BOT_TOKEN",
  botUserIdEnv: "SLACK_BOT_USER_ID",
  apiTimeoutMs: 3000,
  cacheTtlMs: 0,
  stateTtlDays: 90,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function emojiName(value: unknown, fallback: string): string {
  return stringValue(value, fallback).replace(/^:+|:+$/g, "");
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

export function resolvePluginConfig(value: unknown): PluginConfig {
  const raw = isObject(value) ? value : {};
  const candidateEnv = stringValue(raw.botTokenEnv, DEFAULT_CONFIG.botTokenEnv);
  const botTokenEnv = /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidateEnv)
    ? candidateEnv
    : DEFAULT_CONFIG.botTokenEnv;
  const candidateUserIdEnv = stringValue(raw.botUserIdEnv, DEFAULT_CONFIG.botUserIdEnv);
  const botUserIdEnv = /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidateUserIdEnv)
    ? candidateUserIdEnv
    : DEFAULT_CONFIG.botUserIdEnv;
  const agentId = typeof raw.agentId === "string" && raw.agentId.trim()
    ? raw.agentId.trim()
    : undefined;

  return {
    muteEmoji: emojiName(raw.muteEmoji, DEFAULT_CONFIG.muteEmoji),
    resumeEmoji: emojiName(raw.resumeEmoji, DEFAULT_CONFIG.resumeEmoji),
    botTokenEnv,
    botUserIdEnv,
    apiTimeoutMs: integerValue(raw.apiTimeoutMs, DEFAULT_CONFIG.apiTimeoutMs, 250, 30_000),
    cacheTtlMs: integerValue(raw.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, 0, 60_000),
    stateTtlDays: integerValue(raw.stateTtlDays, DEFAULT_CONFIG.stateTtlDays, 1, 3650),
    ...(agentId ? { agentId } : {}),
  };
}
