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

  it("detects an explicit bot mention from the raw threaded Slack message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      messages: [{ ts: "1712.0002", text: "<@USERGIO> reviens" }],
    }), { status: 200 }));
    const client = new SlackReactionClient({
      token: "token",
      botUserId: "USERGIO",
      muteEmoji: "no_bell",
      resumeEmoji: "bell",
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(client.hasExplicitBotMention("C123", "1712.0001", "1712.0002"))
      .resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.replies?channel=C123&ts=1712.0001&oldest=1712.0002&latest=1712.0002&inclusive=true&limit=1",
      expect.anything(),
    );
  });

  it("resolves and caches the bot user id with auth.test", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      user_id: "USERGIO",
    }), { status: 200 }));
    const client = new SlackReactionClient({
      token: "token",
      muteEmoji: "no_bell",
      resumeEmoji: "bell",
      timeoutMs: 1000,
      fetchImpl,
    });

    await client.warmupIdentity();
    await client.warmupIdentity();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://slack.com/api/auth.test");
  });
});
