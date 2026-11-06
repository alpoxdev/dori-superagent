# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

## 1. herdr-core

The Dori runs in herdr-core (`hc`): every session, yours and each lane, is an `hc` terminal that stays alive, and hc reads, types into and reports the status of each one (omp reports idle, working, blocked and done to it on its own). Run `hc --skill` unless its manual is already in your context.

```sh
hc server status                    # herdr-core is running (Herdr.app starts it)
hc run --bg --name dori-lead --cwd ~/dev omp --model <model>   # how the lead itself runs
```

The older herdr multiplexer still works: set `"terminal": "herdr"` in the config, install `herdr integration install omp` so herdr sees omp's state, and run inside herdr.

## 2. Messenger

Install agent-messenger (github.com/agent-messenger/agent-messenger) and read which platforms it supports. Ask the owner which one to use and wait for the answer.

agent-messenger wraps part of each platform. Read the platform's current bot API changelog and call the API directly for the rest:

- Telegram: stream a reply as it grows and show "Thinking…" with message drafts, send rich messages for tables and headings, and use topics in the private chat (turn on threaded mode in BotFather's mini app; there is no API for that switch).
- Discord: edit your own messages to grow them, and use threads.

### If the owner picks Slack: user token or bot token

Ask which mode, give the trade-off as a short list, and wait for the choice:

- **User token**: the Dori acts as a real member of the workspace.
  - It needs a paid seat, which the owner pays for.
  - It reads everything that member can see.
  - It can keep a green online dot (`dori presence slack`).
- **Bot token**: the Dori is a Slack app.
  - There's no seat cost.
  - It only sees channels it is invited to, within the scopes the app was granted.
  - It shows as an app, not a person.

Record the choice. With a user token, set `DORI_SLACK_TOKEN` and `DORI_SLACK_COOKIE` (the `d` cookie from that member's browser session). With a bot token, set `DORI_SLACK_TOKEN` to the `xoxb-` token.

## 3. Bot

Finish every login in the browser. Create the bot with agent-messenger and finish its setup. Then give it its avatar: the default is `assets/dori-avatar.png` in this skill, and the owner can swap in any image.

- **Telegram**: @BotFather → `/setuserpic` → pick the bot → send the image.
- **Discord**: Developer Portal → your application → **General Information** → App Icon, and **Bot** → Icon.
- **Slack**:
  - bot token: the app's **Basic Information** → Display Information → App icon;
  - user token: the member's profile photo (`users.setPhoto`, or the profile page).

Greet the owner through the bot before doing anything else.

## 4. Scripts

```sh
cd skills/dori-mode/scripts && bun install && bun link    # puts `dori` on PATH
mkdir -p ~/.dori && cp ../references/config.example.json ~/.dori/config.json
```

Then edit `~/.dori/config.json`: at least `leadPane` (your own terminal: its `hc` name such as `dori-lead`, or `$HC_TERMINAL_ID`), `laneWorkspace` (the `workspace=` label lane terminals get), `defaultCwd`, and the two hooks if you want lane threads updated automatically. `references/scripts.md` explains every field.

## 5. Relays

omp has no line-filtered monitor: a background job reports only when it ends. Run each watcher under `dori relay` instead. It runs the command, prints all of its output, and types each line that matches `--filter` into `leadPane` (or `--to PANE`) as its own message, once, in order, and only while that agent is idle or done: text typed into a turn can be lost, so lines wait while you work and arrive after your turn ends. A line it could not type (no live agent, a shell in front, a blocked dialog) is retried every 5 seconds; backticks and `$(` in a line are defused so the line still arrives.

Start each in its own terminal that outlives your session (`hc run --bg --no-parent --name dori-<relay> -- <command>`), or as an omp named service (`bash` with a `name`):

| Relay | Command | Filter (`--filter`) |
|---|---|---|
| inbound messages | `dori relay --filter '<new owner message>' -- <your messenger's watch command>` | new owner messages |
| done flow | `dori relay --filter '^LANE_' -- dori watch` | `^LANE_` |
| dead panes | `dori relay --filter '^(DEAD_PANE\|UNRECOGNISED_PANE)' -- dori dead-panes --loop 3` | `^(DEAD_PANE\|UNRECOGNISED_PANE)` |
| host guard | `dori relay --filter '^HOST_GUARD' -- dori guard --loop 1` | `^HOST_GUARD` |
| freshness | `dori relay --filter '^(NUDGED\|POSTED\|NO-REPORT\|PENDING-REPORT\|STALE-REPORT\|STALLED\|JOURNAL-ERROR\|WORKING-WHILE-PAUSED)' -- dori freshness --loop 5` | `^(NUDGED\|POSTED\|…\|WORKING-WHILE-PAUSED)` |
| Slack inbound (Slack only) | `dori relay --filter '^INBOUND' -- dori inbound slack --loop 1` | `^INBOUND` |
| Telegram inbound (Telegram only) | `DORI_TELEGRAM_TOKEN=… DORI_TELEGRAM_OWNER_ID=… dori relay --filter '^INBOUND' -- dori inbound telegram --loop 1` | `^INBOUND` |
| presence (optional) | `dori relay --filter '^PRESENCE_READY' -- dori presence slack` (or `discord`) | `^PRESENCE_READY` |

In a shell the `|` inside a filter is a plain `|`; the table escapes it only for Markdown. When the relayed command exits, `dori relay` exits with its code after one more minute of retries, and prints `RELAY_UNDELIVERED <n>` if lines were left.

With Telegram, also run `DORI_TELEGRAM_TOKEN=… dori typing telegram` beside the relays (a named service or its own pane, not under `dori relay`: it prints nothing to relay). It shows you as typing in the owner's chat while you work on an unanswered message.

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.
