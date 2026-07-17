import { describe, expect, it } from "vitest";
import { transitionThreadState } from "../src/state-machine.js";
import { requestResumeWithoutSnapshot } from "../src/state-machine.js";
import type { ReactionSnapshot, ThreadState } from "../src/types.js";

const at = 1_000;
const snapshot = (muteCount: number, resumeCount = 0): ReactionSnapshot => ({
  muteCount,
  resumeCount,
  fetchedAt: at,
});

describe("transitionThreadState", () => {
  it("mutes on the first no_bell reaction", () => {
    expect(transitionThreadState(undefined, snapshot(1), false, at)).toMatchObject({
      mode: "muted",
      lastMuteCount: 1,
      resumedMuteCount: 0,
    });
  });

  it("keeps empty threads active without storing state", () => {
    expect(transitionThreadState(undefined, snapshot(0), false, at)).toBeUndefined();
  });

  it("resumes on an explicit mention and stays active at the same mute count", () => {
    const muted = transitionThreadState(undefined, snapshot(2), false, at)!;
    const resumed = transitionThreadState(muted, snapshot(2), true, at + 1)!;
    const later = transitionThreadState(resumed, snapshot(2), false, at + 2)!;
    expect(resumed).toMatchObject({ mode: "active", resumedMuteCount: 2 });
    expect(later.mode).toBe("active");
  });

  it("mutes again when another no_bell is added", () => {
    const resumed: ThreadState = {
      mode: "active",
      lastMuteCount: 1,
      lastResumeCount: 0,
      resumedMuteCount: 1,
      updatedAt: at,
    };
    expect(transitionThreadState(resumed, snapshot(2), false, at + 1)?.mode).toBe("muted");
  });

  it("reactivates when all no_bell reactions are removed", () => {
    const muted = transitionThreadState(undefined, snapshot(1), false, at)!;
    expect(transitionThreadState(muted, snapshot(0), false, at + 1)).toBeUndefined();
  });

  it("resumes when a bell reaction is added", () => {
    const muted = transitionThreadState(undefined, snapshot(1), false, at)!;
    expect(transitionThreadState(muted, snapshot(1, 1), false, at + 1)).toMatchObject({
      mode: "active",
      lastResumeCount: 1,
      resumedMuteCount: 1,
    });
  });

  it("does not let a stale bell override a later mute", () => {
    const bellOnly = transitionThreadState(undefined, snapshot(0, 1), false, at)!;
    expect(transitionThreadState(bellOnly, snapshot(1, 1), false, at + 1)?.mode).toBe("muted");
  });

  it("returns to the resumed baseline when a newer mute is removed", () => {
    const resumed = transitionThreadState(undefined, snapshot(2), true, at)!;
    const remuted = transitionThreadState(resumed, snapshot(3), false, at + 1)!;
    expect(remuted.mode).toBe("muted");
    expect(transitionThreadState(remuted, snapshot(2), false, at + 2)?.mode).toBe("active");
  });

  it("consumes a resume queued by message_received on the next reaction snapshot", () => {
    const pending = requestResumeWithoutSnapshot(undefined, at);
    expect(pending).toMatchObject({ mode: "active", resumePending: true });
    expect(transitionThreadState(pending, snapshot(1), false, at + 1)).toMatchObject({
      mode: "active",
      resumedMuteCount: 1,
      resumePending: false,
    });
  });
});
