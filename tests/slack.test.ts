import { describe, expect, it, vi } from "vitest";
import { SlackReactionClient, SlackReactionError } from "../src/slack.js";

describe("SlackReactionClient", () => {
  it("reads aggregate reaction counts from the root message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      message: {
        reactions: [
          { name: "no_bell", count: 2, users: ["U1"] },
          { name: "bell", count: 1, users: [] },
        ],
      },
    }), { status: 200 }));
    const client = new SlackReactionClient({
      token: "xoxb-secret",
      muteEmoji: "no_bell",
      resumeEmoji: "bell",
      timeoutMs: 1000,
      fetchImpl,
      now: () => 42,
    });

    await expect(client.getSnapshot("C123", "1712.0001")).resolves.toEqual({
      muteCount: 2,
      resumeCount: 1,
      fetchedAt: 42,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.get?channel=C123&timestamp=1712.0001&full=true",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-secret" }),
      }),
    );
  });

  it("surfaces Slack API errors without exposing the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "missing_scope",
    }), { status: 200 }));
    const client = new SlackReactionClient({
      token: "xoxb-secret",
      muteEmoji: "no_bell",
      resumeEmoji: "bell",
      timeoutMs: 1000,
      fetchImpl,
    });

    const error = await client.getSnapshot("C123", "1712.0001").catch((value) => value);
    expect(error).toBeInstanceOf(SlackReactionError);
    expect(error).toMatchObject({ code: "missing_scope" });
    expect(String(error)).not.toContain("xoxb-secret");
  });

  it("reports rate limits with retry timing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", {
      status: 429,
      headers: { "retry-after": "2" },
    }));
    const client = new SlackReactionClient({
      token: "token",
      muteEmoji: "no_bell",
      resumeEmoji: "bell",
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(client.getSnapshot("C123", "1712.0001")).rejects.toMatchObject({
      code: "ratelimited",
      retryAfterMs: 2000,
    });
  });
});
