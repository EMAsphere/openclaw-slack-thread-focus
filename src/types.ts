export type FocusMode = "active" | "muted";

export type ReactionSnapshot = {
  muteCount: number;
  resumeCount: number;
  fetchedAt: number;
};

export type ThreadState = {
  mode: FocusMode;
  lastMuteCount: number;
  lastResumeCount: number;
  resumedMuteCount: number;
  updatedAt: number;
};

export type ThreadReference = {
  agentId: string;
  accountId: string;
  channelId: string;
  threadTs: string;
};

export type FocusDecision = {
  muted: boolean;
  source: "slack" | "stored" | "fail-open" | "mention";
  state?: ThreadState;
};

export type PluginConfig = {
  muteEmoji: string;
  resumeEmoji: string;
  botTokenEnv: string;
  apiTimeoutMs: number;
  cacheTtlMs: number;
  stateTtlDays: number;
  agentId?: string;
};

export type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};
