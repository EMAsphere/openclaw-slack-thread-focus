# OpenClaw Slack Thread Focus

An OpenClaw plugin that lets anyone stop a claw from following a Slack thread by
adding a 🔕 (`no_bell`) or 🔇 (`mute`) reaction to the thread's root message. Mentioning the
claw again resumes that claw in the conversation.

On OpenClaw `2026.7.1`, the global `message_received` hook records explicit
mentions and `message_sending` enforces the focus state before Slack delivery.
The plugin also registers `inbound_claim` for hosts and conversation bindings
that deliver it, but global plugins do not receive that hook in `2026.7.1`.

## Behaviour

- Any Slack user can mute a thread; reactor identity is deliberately ignored.
- A root-message 🔕 or 🔇 mutes the current claw for that thread.
- An explicit `@claw` mention resumes only that claw, even while either reaction remains.
- Adding 🔔 (`bell`) also resumes the claw; this is optional convenience
  behaviour.
- Adding another 🔕 or 🔇 after a resume mutes the claw again.
- Removing all mute reactions (both 🔕 and 🔇) reactivates the thread.
- State is persisted per OpenClaw state directory, Slack account, channel,
  thread and agent. Restarts and context compaction do not reset it.
- Reactions on thread replies are ignored. Only the root message controls focus.

The plugin calls Slack's `reactions.get` API on the root message. Because
OpenClaw removes native Slack mentions from the normalized `message_received`
content, it also uses `conversations.replies` to inspect the current raw Slack
message. The bot needs `reactions:read` plus the normal OpenClaw history scopes
(`channels:history`, `groups:history`, `im:history`, and `mpim:history` for the
conversation types it uses).

## Install

After the package is published:

```bash
openclaw plugins install @emasphere/openclaw-slack-thread-focus@0.1.3
```

Enable it in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "slack-thread-focus": {
        "enabled": true
      }
    }
  }
}
```

For the OpenClaw Kubernetes operator:

```yaml
spec:
  plugins:
    - npm:@emasphere/openclaw-slack-thread-focus@0.1.3
  config:
    raw:
      plugins:
        entries:
          slack-thread-focus:
            enabled: true
```

The bot token is read from `SLACK_BOT_TOKEN` by default. The bot user id can be
provided as `SLACK_BOT_USER_ID`; otherwise the plugin resolves it once with
Slack's `auth.test`. Neither value is written to the plugin state file or logs.

## Configuration

All options are optional:

```json
{
  "plugins": {
    "entries": {
      "slack-thread-focus": {
        "enabled": true,
        "config": {
          "muteEmoji": "no_bell",
          "resumeEmoji": "bell",
          "botTokenEnv": "SLACK_BOT_TOKEN",
          "botUserIdEnv": "SLACK_BOT_USER_ID",
          "apiTimeoutMs": 3000,
          "cacheTtlMs": 0,
          "stateTtlDays": 90
        }
      }
    }
  }
}
```

`cacheTtlMs` defaults to `0` so a newly added mute is observed before every
outgoing delivery. A positive cache reduces Slack API traffic at the cost of a
small window before a fresh reaction is observed.

`muteEmoji` selects the primary mute reaction (`no_bell` by default). `mute` is
always accepted as an alias. Their reaction counts are combined for the same
mute/resume rules, with no double counting if `muteEmoji` is already `mute`.

If Slack is temporarily unavailable, the plugin fails open for unknown or
active threads and keeps known muted threads muted. Native Slack mentions need
the raw-message lookup, so a new resume cannot be guaranteed during a Slack API
outage.

### Multiple Slack bots in one instance

Version 0.1.4 supports a separate token and focus/progress state for each named
Slack account. The keys must match `channels.slack.accounts`. All agents routed
through a configured account receive cards, including specialized agents.

```json
{
  "progressCards": true,
  "accounts": {
    "sergio": { "botTokenEnv": "SERGIO_SLACK_BOT_TOKEN" },
    "roger": { "botTokenEnv": "ROGER_SLACK_BOT_TOKEN" },
    "fabrice": { "botTokenEnv": "FABRICE_SLACK_BOT_TOKEN" },
    "maurice": { "botTokenEnv": "MAURICE_SLACK_BOT_TOKEN" }
  }
}
```

Put this under the plugin's `config` and grant conversation access as shown
below. `accounts` replaces the single-token settings. Each bot resolves its own
identity with `auth.test`, unless its entry supplies `botUserIdEnv`. Hooks ignore
unconfigured accounts. Each named account uses a separate `state-<account>.json`
file, so concurrent bots cannot overwrite another account's mute/resume state.
Existing single-token installations keep their original `state.json`.

To restrict a single-token setup, set `accountId` to its Slack account id;
`progressAccountId` defaults to that value. Without `accountId`, the historical
focus-hook behavior remains unchanged.

### Slack progress cards (opt-in)

On OpenClaw `2026.9.2`, registering an outbound modifier such as our
`message_sending` hook disables Slack's native progress previews. Setting
`channels.slack.streaming.mode: "progress"` alone cannot display those cards
while thread focus is enabled.

Enable this plugin's own Block Kit card instead:

```json
{
  "plugins": {
    "entries": {
      "slack-thread-focus": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": { "progressCards": true }
      }
    }
  }
}
```

The card appears in the originating thread on the first tool or plan event,
then updates in place (at most once every 1.5 seconds per run). It shows tool
names, status, up to eight authored plan steps, and completion/failure. It does
not display tool arguments, results, command output, or model reasoning. Plan
labels are displayed as plain text. A task without tool/plan events has no card.
The final answer still uses OpenClaw's normal delivery and focus gate.

OpenClaw can deliver conversation hooks and agent events through different
plugin registries. Version 0.1.3 shares the route, pending mention checks, focus
store and card state across matching registrations in the same process. State
is isolated by plugin version, state directory, settings and credentials;
retiring one registry leaves the others' active cards intact. Logs record route
registration, reply matching, run tracking and successful card creation without
message contents or tool arguments.

Every card write waits for pending mention checks and reads fresh root-message
reactions. A muted thread gets no card; a newly observed mute deletes this run's
existing card and stops further progress for that run. Checks happen on progress
events, not continuously during a long-running tool. On a reaction lookup failure,
progress writes are skipped, even if final replies would fail open. On a write
failure (including rate limits), progress stops for that run without retrying a
possibly successful post. Existing cards may remain stale after an outage,
restart, or interrupted event stream.

Requires Slack `chat:write`, the existing reaction/history scopes, and the host's
agent-event and runtime-lifecycle APIs. Enable capability consent after upgrading:
`openclaw plugins enable slack-thread-focus --accept-capabilities`.
OpenClaw `2026.9.2` also requires the explicit `hooks.allowConversationAccess`
grant shown above for `before_agent_reply`. The plugin observes that hook only
to correlate a user turn with its Slack thread; it does not modify the reply.

The bot token must belong to `progressAccountId` (default `"default"`). Other
Slack accounts are ignored for progress. Only recently received Slack messages
followed by a user reply turn are eligible; cron/heartbeat and unknown sessions
do not create progress cards. This direct Slack card implements the focus check
itself; it does not pass through other plugins' outbound message modifiers.

Before npm publication, build an archive from the desired Git commit:

```bash
npm ci
npm run check
npm pack
openclaw plugins install ./emasphere-openclaw-slack-thread-focus-0.1.4.tgz --force --accept-capabilities
```

Install the resulting archive on the host. Direct Git installation does not
build `dist/`, which OpenClaw requires for installed packages. Keep the archive
or rebuild from the same commit when restoring the persistent plugin directory.

## Development

Requires Node.js 22.22.3 or newer in a version supported by OpenClaw.

```bash
npm install
npm run check
npm pack --dry-run
```

The implementation targets OpenClaw `2026.7.1` and uses its public plugin SDK.

## Known limits

- In OpenClaw `2026.7.1`, `inbound_claim` is only delivered to a plugin selected
  by a core conversation binding; it is not broadcast to global plugins. A
  muted inbound message can therefore still run the model and consume tokens.
  `message_sending` suppresses the final Slack delivery. True pre-model blocking
  requires an OpenClaw core change that broadcasts `inbound_claim`.

- Slack Enterprise Grid organization-wide installs do not deliver incoming
  reaction events to OpenClaw. This plugin does not depend on those events, but
  the bot still needs permission to read reactions in each accessible channel.
- A reaction added after streaming output is already visible cannot retract
  those chunks. The final send is still cancelled. Disable Slack streaming when
  strict no-output-after-mute behaviour is required.
- A remove-and-readd cycle that happens entirely between two checks and leaves
  the same aggregate reaction count cannot be distinguished by Slack's
  aggregate reaction response.

## License

MIT
