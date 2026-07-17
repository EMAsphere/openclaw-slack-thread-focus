import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerSlackThreadFocus } from "./plugin.js";

export { resolvePluginConfig } from "./config.js";
export { ThreadFocusController, type ReactionReader } from "./controller.js";
export { containsAgentNameMention } from "./mention.js";
export { resolveInboundReference, resolveOutboundReference } from "./routing.js";
export { SlackReactionClient, SlackReactionError } from "./slack.js";
export { transitionThreadState } from "./state-machine.js";
export { JsonThreadStateStore, threadStateKey } from "./store.js";
export type * from "./types.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "slack-thread-focus",
  name: "Slack Thread Focus",
  description: "Mute an OpenClaw in a Slack thread with a reaction and resume it with a mention",
  register(api: OpenClawPluginApi) {
    registerSlackThreadFocus(api);
  },
});

export default plugin;
