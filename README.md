# context-meter

A Claude Code mod (function-hook plugin) that shows how full the context window is, for this session and for every other session that is actively working.

The UI text is in Swedish.

## What it draws

**A band above the prompt**, per session:

- `Context 15% +`: this session's fill, colored green, yellow or red. `+` opens the comparison pane, `−` closes it.
- `×` hides the band in this session. `/context-meter` brings it back.
- **Compact now** asks the session to write its own `/compact` summary, then compacts with it.
- **☐ Auto-compact 50%** does the same by itself once the session reaches the threshold. Per session.
- **⚙ Options** opens the settings, shared by all sessions.

**The comparison pane** lists every session whose transcript was written recently, sorted by fill, with a bar, tokens / window and folder. A `[Compact]` button appears on a row at or above the threshold. Rows marked `≈` are sessions that do not run the mod. Their fill is estimated from the transcript.

## Options

| Option | Default |
|---|---|
| Auto-compact at | 50 % |
| Auto-compact on in new sessions | No |
| `[Compact]` in the pane from | 50 % |
| Yellow from / red above | 50 % / 75 % |
| Show sessions active within | 10 min |
| Show sessions without the mod (≈) | Yes |
| Open the comparison pane at start | Yes |

## How compaction works

A session can only compact itself, so a request goes through a file:

1. The button writes `~/.claude/context-meter/requests/<session id>.json`.
2. The target session picks it up on its next tick (every 15 s) and submits a prompt starting with `Pausa dev här och skriv en bra /compact`.
3. When that turn completes, its answer becomes the instructions for `$.session.compact`, retried up to five times while the session is busy.

## Files it writes

All under `~/.claude/context-meter/`:

- `<session id>.json`: one heartbeat per session, every 15 s.
- `requests/`: compaction requests and their state.
- `prefs.json`: the options.

## Install

Clone it anywhere and point Claude Code at the folder. For every session, set this in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\context-meter" } }
```

A session loads it at start. The estimated rows need `python` on `PATH` (`scripts/scan.py`).

`.claude-plugin/types/` holds the Claude Code type definitions. Claude Code generates them locally and they are not committed.

```bash
claude plugin validate .
```

## License

MIT, see [LICENSE](LICENSE).
