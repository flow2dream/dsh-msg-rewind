# dsh-chat-rewind

Conversation rewind commands for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) web.

- `/undo` — roll the chat back one full turn (drop the last real user message and everything after it)
- `/rewind` — pick a past user message from a dialog and cut the conversation back to it
- **Visual rewind** — hover a user message bubble in the chat and click the ⤺ undo button to rewind to that point

Both the model context **and** the visible transcript are truncated, and the durable JSONL artifact is rewritten so the cut survives a restart.

## Features

| Capability | Detail |
| --- | --- |
| `/undo` | Reverts the previous turn: deletes the last real user message and all events after it |
| `/rewind` (bare) | Opens a dialog listing every user message (chronological, most recent preselected); pick one to rewind there |
| `/rewind <seq>` | Directly rewinds to the given message seq |
| Visual rewind | Hover any user bubble → click the undo icon (shown with time + copy) to rewind to that message |
| Durable | Rewrites the session's JSONL+zstd artifact; the cut survives a restart |
| Clean UI | No "command completed" noise cards after a rewind |

## Requirements

- DeepSeek Harness web (dsh web)
- Node `^22.19.0 || >=24.0.0`

## Install

### Via dshmarket (recommended)

```bash
dsh market add dsh-chat-rewind
dsh market enable dsh-chat-rewind
```

### Manual (file install)

Add the dependency and bundle to your web profile:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-chat-rewind": "github:flow2dream/dsh-msg-rewind"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-chat-rewind"]
    }
  }
}
```

Then install and restart the web profile:

```bash
cd ~/.dsh/profiles/web
npm install
dsh web
```

## Usage

In any conversation:

- Type `/undo` — the chat rolls back one turn.
- Type `/rewind` — a dialog opens with every user message; the most recent one is preselected. Arrow keys navigate, Enter rewinds.
- Hover a **user** message bubble — a small undo icon appears next to the copy button; click it to rewind to that message.

The rewind target is the real user message (system injections such as runtime-context and skill-catalog snapshots are never treated as user turns).

## How it works

- **Host** (`lib/index.js`) registers the `/undo` and `/rewind` commands. A rewind drains the persistence coordinator, splices the live session log, resets every derived cache, rewrites the JSONL artifact, resets the agent's request-header anchor, and broadcasts `session/rewind`.
- **Browser** (`lib/client.js`) listens for `session/rewind`, resyncs the target session's window from the host, and injects the hover undo button into user bubbles.
- The `session/rewind` event is allowlisted in `dsh-api-remotes`'s forwarded events.

## Development

```bash
# from your web profile
npm install /path/to/dsh-chat-rewind
```

Source lives in `lib/`:

- `lib/index.js` — host half (commands + truncation)
- `lib/client.js` — browser half (resync + visual rewind)

## License

MIT
