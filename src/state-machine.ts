import type { ReactionSnapshot, ThreadState } from "./types.js";

function sameState(left: ThreadState | undefined, right: Omit<ThreadState, "updatedAt">): boolean {
  return left?.mode === right.mode &&
    left.lastMuteCount === right.lastMuteCount &&
    left.lastResumeCount === right.lastResumeCount &&
    left.resumedMuteCount === right.resumedMuteCount;
}

function materialize(
  previous: ThreadState | undefined,
  next: Omit<ThreadState, "updatedAt">,
  now: number,
): ThreadState {
  if (previous && sameState(previous, next)) {
    return previous;
  }
  return { ...next, updatedAt: now };
}

export function transitionThreadState(
  previous: ThreadState | undefined,
  snapshot: ReactionSnapshot,
  explicitMention: boolean,
  now: number,
): ThreadState | undefined {
  const muteCount = Math.max(0, Math.trunc(snapshot.muteCount));
  const resumeCount = Math.max(0, Math.trunc(snapshot.resumeCount));

  if (muteCount === 0 && resumeCount === 0) {
    return undefined;
  }

  if (muteCount === 0) {
    return materialize(previous, {
      mode: "active",
      lastMuteCount: 0,
      lastResumeCount: resumeCount,
      resumedMuteCount: 0,
    }, now);
  }

  const resumeReactionAdded = previous
    ? resumeCount > previous.lastResumeCount
    : resumeCount > 0;
  const resumedMuteCount = explicitMention || resumeReactionAdded
    ? muteCount
    : (previous?.resumedMuteCount ?? 0);
  const mode = muteCount <= resumedMuteCount ? "active" : "muted";

  return materialize(previous, {
    mode,
    lastMuteCount: muteCount,
    lastResumeCount: resumeCount,
    resumedMuteCount,
  }, now);
}

export function resumeWithoutSnapshot(
  previous: ThreadState | undefined,
  now: number,
): ThreadState | undefined {
  if (!previous) {
    return undefined;
  }
  return materialize(previous, {
    ...previous,
    mode: "active",
    resumedMuteCount: Math.max(previous.resumedMuteCount, previous.lastMuteCount),
  }, now);
}
