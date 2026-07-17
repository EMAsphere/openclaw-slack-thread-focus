import { describe, expect, it } from "vitest";
import { resolveInboundReference, resolveOutboundReference } from "../src/routing.js";

describe("Slack routing", () => {
  it("resolves the root thread and agent from an inbound canonical session", () => {
    expect(resolveInboundReference({
      event: {
        accountId: "work",
        conversationId: "C123",
        threadId: "1712.0001",
        sessionKey: "agent:roger:slack:channel:C123:thread:1712.0001",
      },
      context: {},
    })).toEqual({
      agentId: "roger",
      accountId: "work",
      channelId: "C123",
      threadTs: "1712.0001",
    });
  });

  it("uses Slack replyToId for outgoing threaded delivery", () => {
    expect(resolveOutboundReference({
      defaultAgentId: "roger",
      event: { to: "C123", replyToId: "1712.0001" },
      context: { channelId: "slack", accountId: "default", conversationId: "C123" },
    })).toEqual({
      agentId: "roger",
      accountId: "default",
      channelId: "C123",
      threadTs: "1712.0001",
    });
  });

  it("prefers Slack replyToId when both outbound thread fields are present", () => {
    expect(resolveOutboundReference({
      defaultAgentId: "roger",
      event: { to: "C123", replyToId: "root", threadId: "nested" },
      context: { channelId: "slack", conversationId: "C123" },
    })?.threadTs).toBe("root");
  });
});
