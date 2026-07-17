# OpenClaw Slack Thread Focus

An OpenClaw plugin that lets anyone stop a claw from following a Slack thread by
adding a 🔕 reaction (`no_bell`) to the thread's root message. Mentioning the
claw again resumes that claw in the conversation.

The decision is made in the `inbound_claim` hook, before the model is called, so
muted messages consume no model tokens. A second check in `message_sending`
cancels a reply when the mute reaction was added while the claw was already
working.

## Behaviour

- Any Slack user can mute a thread; reactor identity is deliberately ignored.
- A root-message 🔕 mutes the current claw for that thread.
- An explicit `@claw` mention resumes only that claw, even while 🔕 remains.
- Adding 🔔 (`bell`) also resumes the claw; this is optional convenience
  behaviour.
- Adding another 🔕 after a resume mutes the claw again.
- Removing all 🔕 reactions reactivates the thread.
- State is persisted per OpenClaw state directory, Slack account, channel,
  thread and agent. Restarts and context compaction do not reset it.
- Reactions on thread replies are ignored. Only the root message controls focus.

The plugin calls Slack's `reactions.get` API on the root message. It therefore
needs the `reactions:read` bot scope in addition to the normal OpenClaw Slack
configuration.

## Install

After the package is published:

```bash
openclaw plugins install @emasphere/openclaw-slack-thread-focus@0.1.0
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
    - npm:@emasphere/openclaw-slack-thread-focus@0.1.0
  config:
    raw:
      plugins:
        entries:
          slack-thread-focus:
            enabled: true
```

The bot token is read from `SLACK_BOT_TOKEN` by default. It is never written to
the plugin state file or logs.

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
model call. A positive cache reduces Slack API traffic at the cost of a small
window in which a fresh reaction may only be caught by the outgoing check.

If Slack is temporarily unavailable, the plugin fails open for unknown or
active threads and keeps known muted threads muted. An explicit mention always
resumes the claw locally, even during a Slack API outage.

## Development

Requires Node.js 22.22.3 or newer in a version supported by OpenClaw.

```bash
npm install
npm run check
npm pack --dry-run
```

The implementation targets OpenClaw `2026.7.1` and uses its public plugin SDK.

## Known limits

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
