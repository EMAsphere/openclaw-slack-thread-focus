import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ThreadFocusController } from "../src/controller.js";
import { JsonThreadStateStore } from "../src/store.js";
import type { ThreadReference } from "../src/types.js";

const reference: ThreadReference = {
  agentId: "roger",
  accountId: "default",
  channelId: "C123",
  threadTs: "1712.0001",
};

async function store(): Promise<JsonThreadStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "thread-focus-"));
  return new JsonThreadStateStore(join(directory, "state.json"), 100_000);
}

describe("ThreadFocusController", () => {
  it("persists a mute and lets a mention resume only the addressed agent", async () => {
    const reactions = { getSnapshot: vi.fn().mockResolvedValue({
      muteCount: 1,
      resumeCount: 0,
      fetchedAt: Date.now(),
    }) };
    const controller = new ThreadFocusController(await store(), reactions, 0, {});

    await expect(controller.evaluate(reference, false, true)).resolves.toMatchObject({ muted: true });
    await expect(controller.evaluate(reference, true, true)).resolves.toMatchObject({
      muted: false,
      source: "mention",
    });
    await expect(controller.evaluate(reference, false, true)).resolves.toMatchObject({ muted: false });
    await expect(controller.evaluate({ ...reference, agentId: "maurice" }, false, true))
      .resolves.toMatchObject({ muted: true });
  });

  it("keeps known muted threads muted during a Slack outage", async () => {
    const stateStore = await store();
    const reactions = { getSnapshot: vi.fn()
      .mockResolvedValueOnce({ muteCount: 1, resumeCount: 0, fetchedAt: Date.now() })
      .mockRejectedValueOnce(new Error("offline")) };
    const controller = new ThreadFocusController(stateStore, reactions, 0, {});
    await controller.evaluate(reference, false, true);
    await expect(controller.evaluate(reference, false, true)).resolves.toMatchObject({
      muted: true,
      source: "stored",
    });
  });

  it("persists a message_received resume before the outgoing reaction check", async () => {
    const reactions = { getSnapshot: vi.fn().mockResolvedValue({
      muteCount: 1,
      resumeCount: 0,
      fetchedAt: Date.now(),
    }) };
    const controller = new ThreadFocusController(await store(), reactions, 0, {});
    await controller.evaluate(reference, false, true);
    await controller.requestResume(reference);
    await expect(controller.evaluate(reference, false, true)).resolves.toMatchObject({
      muted: false,
      state: { resumePending: false, resumedMuteCount: 1 },
    });
  });

  it("fails open for unknown threads during a Slack outage", async () => {
    const reactions = { getSnapshot: vi.fn().mockRejectedValue(new Error("offline")) };
    const controller = new ThreadFocusController(await store(), reactions, 0, {});
    await expect(controller.evaluate(reference, false, true)).resolves.toEqual({
      muted: false,
      source: "fail-open",
    });
  });
});
