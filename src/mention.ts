export function containsAgentNameMention(content: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const normalized = name.trim();
    if (!normalized) {
      return false;
    }
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w])@${escaped}(?=$|[^\\w])`, "i").test(content);
  });
}
