# context-meter

A Claude Code mod (function-hook plugin) that shows how full the context window is, for this session and for every other session that is actively working.

The UI text is in Swedish.

## What it draws

**A band above the prompt**, per session:

- `Context 15% +`: this session's fill, colored green, yellow or red. `+` opens the comparison pane, `−` closes it.
- `×` hides the band in this session. `/context-meter` brings it back.
- **Compact now** compacts this session at once with the structured instructions below.
- **☐ Auto-compact 50%** does the same by itself once the session reaches the threshold. Per session.
- **⚙ Options** opens the settings, shared by all sessions.

**The comparison pane** lists every session whose transcript was written recently, sorted by fill, with a bar, tokens / window and folder. A `[Compact]` button appears on a row at or above the threshold. Rows marked `≈` are sessions that do not run the mod. Their fill is estimated from the transcript.

## Options

| Option | Default |
|---|---|
| Auto-compact at | 50 % |
| Auto-compact on in new sessions | No |
| Compact when idle after | 55 min (`av` turns it off) |
| …if the context is at least | 150k tokens |
| `[Compact]` in the pane from | 50 % |
| Yellow from / red above | 50 % / 75 % |
| Show sessions active within | 10 min |
| Show sessions without the mod (≈) | Yes |
| Open the comparison pane at start | Yes |

## How compaction works

A session can only compact itself, so a request goes through a file:

1. The button writes `~/.claude/context-meter/requests/<session id>.json`.
2. The target session picks it up on its next tick (every 15 s) and compacts with the structured instructions below: one model call, the same as a bare `/compact`.
3. A compaction refused while a turn runs is retried up to five times, then sent as the `/compact` command.

## Idle compact

The API keeps the prompt cache for an hour. A prompt sent after a longer pause writes the whole context into the cache again, at twice the input price. A session that has had no turn for the idle time (55 min by default), with at least 150k tokens of context, therefore compacts itself through the same steps as Compact now. The compaction reads the context from a warm cache, and the return starts from the smaller compacted context. It runs once per idle stretch, only while the cache is still warm (under 60 minutes), and not after a session is resumed, since the cache is cold by then.

## Every compaction gets structured instructions

Compact now, idle compact and every compaction that arrives without instructions of its own (the engine's auto-compact at its threshold, a bare `/compact`, a precompute) get a fixed outline. The summary then has the headings LÄGE, GJORT, BESLUT, FILER, FEL OCH LÖSNINGAR, NÄSTA STEG and FAST, with exact paths, ids, commands and numbers. The decisive line of each error is quoted verbatim, so the full tool output can be found again in the session transcript by searching for that line. A `/compact` typed with text keeps that text. Subagents' own compactions are left alone.

Every summary that stands is saved to `compacts/<UTC time>_<session id>.md`, with the session, folder, trigger and tokens before and after. Other sessions can search them there.

## Files it writes

All under `~/.claude/context-meter/`:

- `<session id>.json`: one heartbeat per session, every 15 s.
- `requests/`: compaction requests and their state.
- `compacts/`: one Markdown file per compaction, the summary as it stands.
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
