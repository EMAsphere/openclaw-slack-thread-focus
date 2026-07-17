import { describe, expect, it } from "vitest";
import { containsAgentNameMention } from "../src/mention.js";

describe("containsAgentNameMention", () => {
  it("matches a textual mention without accepting a longer name", () => {
    expect(containsAgentNameMention("@Sergio reviens", ["Sergio"])).toBe(true);
    expect(containsAgentNameMention("@Sergiobot reviens", ["Sergio"])).toBe(false);
  });

  it("escapes regular-expression characters in agent names", () => {
    expect(containsAgentNameMention("ping @Sergio (previews)!", ["Sergio (previews)"]))
      .toBe(true);
  });
});
