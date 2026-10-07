import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CompactRequest, CompactState, ContextBeat, MeterPrefs } from '../types'

const PANE = 'context-meter'
const BEAT_MS = 15_000
// A session whose heartbeat is older than this has quit or crashed.
const STALE_MS = 90_000
// The scan, the activity filter (prefs.activeMinutes), reruns this often.
const SCAN_MS = 60_000

const DEFAULT_PREFS: MeterPrefs = {
  isHidden: false,
  autoAt: 50,
  buttonAt: 50,
  yellowAt: 50,
  redAt: 75,
  activeMinutes: 10,
  showEstimated: true,
  autoInNewSessions: false,
}

// What the options' pickers offer; a stored value outside them is added.
const COMPACT_STEPS = [30, 40, 50, 60, 70, 80, 90]
const YELLOW_STEPS = [30, 40, 50, 60, 70, 80]
const RED_STEPS = [50, 60, 70, 75, 80, 90, 95]
const MINUTE_STEPS = [5, 10, 30, 60, 240]

const SUMMARY_MARKER = 'Pausa dev här och skriv en bra /compact'
const SUMMARY_PROMPT =
  `${SUMMARY_MARKER} för den här sessionen: vad som är gjort, vad som återstår, ` +
  'fattade beslut, viktiga filsökvägar och nästa steg. ' +
  'Svara ENDAST med texten som ska stå efter /compact, inget annat.'

const STATE_TEXT: Record<CompactState, string> = {
  requested: 'compact begärd',
  summarizing: 'skriver sammanfattning',
  compacting: 'kompakterar',
  done: 'kompakterad',
  failed: 'compact misslyckades',
}

const beats = atom({ plugin: 'context-meter', key: 'beats' } as const, [])
const scanned = atom({ plugin: 'context-meter', key: 'scanned' } as const, [])
const selfId = atom({ plugin: 'context-meter', key: 'selfId' } as const, '')
const requests = atom({ plugin: 'context-meter', key: 'requests' } as const, {})
const isAwaitingSummary = atom({ plugin: 'context-meter', key: 'isAwaitingSummary' } as const, false)
const isPaneOpen = atom({ plugin: 'context-meter', key: 'isPaneOpen' } as const, false)
// Both per session: the band's close mark, and the auto-compact box.
const isBandHidden = atom({ plugin: 'context-meter', key: 'isBandHidden' } as const, false)
const isAutoCompact = atom({ plugin: 'context-meter', key: 'isAutoCompact' } as const, false)
const isOptionsOpen = atom({ plugin: 'context-meter', key: 'isOptionsOpen' } as const, false)
const prefs = atom({ plugin: 'context-meter', key: 'prefs' } as const, DEFAULT_PREFS)
// After a failed or finished compaction, auto-compact waits this long.
const AUTO_PAUSE_MS = 10 * 60_000

// Green below yellowAt, yellow up to and including redAt, red above.
function colorFor(percent: number, p: MeterPrefs): string | undefined {
  if (percent < p.yellowAt) return 'green'
  if (percent <= p.redAt) return 'yellow'
  return 'red'
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const booleanOr = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

// A hand-edited or older prefs.json falls back field by field.
function toPrefs(raw: unknown): MeterPrefs {
  const p = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_PREFS
  return {
    isHidden: booleanOr(p.isHidden, d.isHidden),
    autoAt: numberOr(p.autoAt, d.autoAt),
    buttonAt: numberOr(p.buttonAt, d.buttonAt),
    yellowAt: numberOr(p.yellowAt, d.yellowAt),
    redAt: numberOr(p.redAt, d.redAt),
    activeMinutes: numberOr(p.activeMinutes, d.activeMinutes),
    showEstimated: booleanOr(p.showEstimated, d.showEstimated),
    autoInNewSessions: booleanOr(p.autoInNewSessions, d.autoInNewSessions),
  }
}

// Yellow stays below red: the field just picked wins, the other gives way.
function ordered(p: MeterPrefs, isRedPicked: boolean): MeterPrefs {
  if (p.yellowAt < p.redAt) return p
  return isRedPicked ? { ...p, yellowAt: p.redAt - 5 } : { ...p, redAt: p.yellowAt + 5 }
}

function percentOptions(steps: readonly number[], current: number, unit = '%') {
  return [...new Set([...steps, current])]
    .sort((a, b) => a - b)
    .map(n => ({ value: String(n), label: `${n}${unit}` }))
}

const YES_NO = [
  { value: 'yes', label: 'Ja' },
  { value: 'no', label: 'Nej' },
]
const yesNo = (isOn: boolean) => (isOn ? 'yes' : 'no')

const kilo = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const isBusy = (r: CompactRequest | undefined) =>
  r !== undefined && (r.state === 'requested' || r.state === 'summarizing' || r.state === 'compacting')

async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
}

async function heartbeatDir($: EngineInterface): Promise<string> {
  return `${await homeDir($)}/.claude/context-meter`
}

// Module variables start over on a reload; the label is cheap to rebuild.
let label = ''

async function labelFor($: EngineInterface, cwd: string): Promise<string> {
  if (label) return label
  const messages = await $.session.messages()
  const first = messages.find(m => m.role === 'user' && m.text.trim() !== '')
  const prompt = first?.text.replace(/\s+/g, ' ').trim().slice(0, 48) ?? ''
  if (prompt) label = prompt
  return prompt || folderName(cwd)
}

async function beat($: EngineInterface, isEnded = false): Promise<void> {
  const [id, cwd, model, usage, now] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.model(),
    $.session.usage(),
    $.clock.now(),
  ])
  const entry: ContextBeat = {
    id,
    label: await labelFor($, cwd),
    cwd,
    model,
    tokens: usage.context.tokens ?? 0,
    window: usage.context.window,
    percent: usage.context.percent ?? 0,
    updatedAt: now,
    isEnded,
  }
  await $.fs.write(`${await heartbeatDir($)}/${id}.json`, JSON.stringify(entry))
}

async function readJsonDir<T>($: EngineInterface, dir: string, maxAgeMs: number): Promise<Array<[string, T]>> {
  const now = await $.clock.now()
  const files = (await $.fs.list(dir).catch(() => [])).filter(
    f => f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs < maxAgeMs,
  )
  const parsed = await Promise.all(
    files.map(f =>
      $.fs
        .read(`${dir}/${f.name}`)
        .then((text): [string, T] => [f.name.slice(0, -'.json'.length), JSON.parse(text) as T])
        .catch(() => undefined),
    ),
  )
  return parsed.filter((p): p is [string, T] => p !== undefined)
}

async function refresh($: EngineInterface): Promise<void> {
  const dir = await heartbeatDir($)
  const now = await $.clock.now()
  const live = (await readJsonDir<ContextBeat>($, dir, STALE_MS))
    .map(([, b]) => b)
    .filter(b => !b.isEnded && now - b.updatedAt < STALE_MS)
  await update($, beats, () => live)
  const asked = await readJsonDir<CompactRequest>($, `${dir}/requests`, 24 * 3_600_000)
  await update($, requests, () => Object.fromEntries(asked))
}

type ScanRow = { id: string; label: string; cwd: string; model: string; tokens: number; updatedAt: number }

// A transcript does not say the model's window: take this session's own,
// and 1M once a session is past 200k.
async function scan($: EngineInterface): Promise<void> {
  const home = await homeDir($)
  const activeSeconds = (await read($, prefs)).activeMinutes * 60
  const [run, usage] = await Promise.all([
    $.process.run(
      ['python', `${$.plugin.root}/scripts/scan.py`, `${home}/.claude/projects`, String(activeSeconds)],
      { timeoutMs: 60_000 },
    ),
    $.session.usage(),
  ])
  if (run.exitCode !== 0) return
  const rows = JSON.parse(run.stdout) as ScanRow[]
  const estimated = rows.map((r): ContextBeat => {
    const window = r.tokens > 200_000 ? Math.max(1_000_000, usage.context.window) : usage.context.window
    return {
      ...r,
      window,
      percent: Math.round((r.tokens / window) * 100),
      isEnded: false,
      isEstimated: true,
    }
  })
  await update($, scanned, () => estimated)
}

// The scan is the activity filter: a session shows only while its transcript
// was written within prefs.activeMinutes (this session always). Heartbeats are
// exact and win; the transcript's title (the name the app shows) labels both.
function merge(exact: ContextBeat[], estimated: ContextBeat[], self: string, showEstimated = true): ContextBeat[] {
  const active = new Map(estimated.map(b => [b.id, b]))
  const exactIds = new Set(exact.map(b => b.id))
  const estimatedOnly = showEstimated
    ? estimated.filter(b => !exactIds.has(b.id)).map(b => ({ ...b, label: b.label || folderName(b.cwd) }))
    : []
  return [
    ...exact
      .filter(b => b.id === self || active.has(b.id))
      .map(b => ({ ...b, label: active.get(b.id)?.label || b.label })),
    ...estimatedOnly,
  ].sort((a, b) => b.percent - a.percent)
}

async function writeRequest($: EngineInterface, id: string, state: CompactState, note?: string): Promise<void> {
  const request: CompactRequest = { state, at: await $.clock.now(), ...(note ? { note } : {}) }
  await $.fs.write(`${await heartbeatDir($)}/requests/${id}.json`, JSON.stringify(request))
  await update($, requests, all => ({ ...all, [id]: request }))
}

// Step 1, in the target session: a requested compaction queues the summary
// prompt, which the engine runs once the session is idle.
async function takeRequest($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const request = (await read($, requests))[id]
  if (request?.state !== 'requested' || (await read($, isAwaitingSummary))) return
  await update($, isAwaitingSummary, () => true)
  await writeRequest($, id, 'summarizing')
  void $.prompt.submit({ text: SUMMARY_PROMPT })
}

// A session may answer as a pasteable block: ```\n/compact text\n```. Only the
// text is the instruction.
function toInstructions(answer: string): string {
  return answer
    .trim()
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim()
    .replace(/^\/compact\s+/, '')
    .trim()
}

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 160)

// Step 2: compact with the summary as instructions. Compaction is refused while
// a turn runs, so it is retried a few times; the last try goes through the
// /compact command instead, and a failure keeps the engine's own words.
async function compactWith($: EngineInterface, instructions: string, attempt: number): Promise<void> {
  const id = await $.session.id()
  try {
    const result = await $.session.compact({ instructions })
    const isSkipped = 'skip' in result && result.skip !== undefined
    await writeRequest($, id, isSkipped ? 'failed' : 'done', isSkipped ? 'avbruten av en hook' : undefined)
    await beat($).catch(() => undefined)
  } catch (error) {
    if (attempt < 5) {
      await writeRequest($, id, 'compacting', `försök ${attempt} avvisat: ${errorText(error)}`)
      $.clock.after(10_000, () => void compactWith($, instructions, attempt + 1))
      return
    }
    try {
      await $.command.run({ command: 'compact', args: instructions })
      await writeRequest($, id, 'done', 'via /compact-kommandot')
      await beat($).catch(() => undefined)
    } catch (fallback) {
      await writeRequest($, id, 'failed', `${errorText(error)} | /compact: ${errorText(fallback)}`)
    }
  }
}

// Read on every tick, so a change made in one session reaches the others.
async function loadPrefs($: EngineInterface): Promise<MeterPrefs> {
  const text = await $.fs.read(`${await heartbeatDir($)}/prefs.json`).catch(() => '')
  let raw: unknown = {}
  try {
    raw = JSON.parse(text)
  } catch {
    // Missing or broken: the defaults stand.
  }
  const loaded = toPrefs(raw)
  await update($, prefs, () => loaded)
  return loaded
}

async function savePrefs($: EngineInterface, patch: Partial<MeterPrefs>): Promise<void> {
  // Re-read first: another session may have changed another option meanwhile.
  const current = await loadPrefs($).catch(() => read($, prefs))
  const next = ordered({ ...current, ...patch }, patch.redAt !== undefined)
  await update($, prefs, () => next)
  await $.fs.write(`${await heartbeatDir($)}/prefs.json`, JSON.stringify(next, null, 2)).catch(() => undefined)
}

// The last choice is also where the next session starts.
async function setPane($: EngineInterface, isOpen: boolean): Promise<void> {
  if (isOpen) {
    await $.ui.open({ id: PANE, title: 'Context' })
  } else {
    await $.ui.close({ id: PANE })
  }
  await update($, isPaneOpen, () => isOpen)
  await savePrefs($, { isHidden: !isOpen })
}

// Compact now: request this session's compaction and take it at once.
async function compactSelf($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if (isBusy((await read($, requests))[id])) return
  await writeRequest($, id, 'requested')
  await takeRequest($)
}

// Auto-compact: a session past prefs.autoAt asks for its own compaction, once;
// a failure or a fresh compaction pauses it for AUTO_PAUSE_MS.
async function autoCompact($: EngineInterface): Promise<void> {
  if (!(await read($, isAutoCompact))) return
  const [id, usage, now, p] = await Promise.all([$.session.id(), $.session.usage(), $.clock.now(), read($, prefs)])
  if ((usage.context.percent ?? 0) < p.autoAt) return
  const request = (await read($, requests))[id]
  if (isBusy(request)) return
  if (request && (request.state === 'failed' || request.state === 'done') && now - request.at < AUTO_PAUSE_MS) return
  await writeRequest($, id, 'requested', 'auto-compact')
}

async function tick($: EngineInterface): Promise<void> {
  await loadPrefs($).catch(() => undefined)
  await beat($).catch(() => undefined)
  await refresh($).catch(() => undefined)
  await autoCompact($).catch(() => undefined)
  await takeRequest($).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, selfId, () => '')
    await $.command.register({
      name: 'context-meter',
      description: 'Visa Context-raden igen, eller visa/dölj jämförelsepanelen',
    })
    void $.session.id().then(id => update($, selfId, () => id))
    void tick($)
    $.clock.every(BEAT_MS, () => void tick($))
    void scan($).catch(() => undefined)
    $.clock.every(SCAN_MS, () => void scan($).catch(() => undefined))
    void loadPrefs($).then(async loaded => {
      await update($, isAutoCompact, () => loaded.autoInNewSessions)
      if (loaded.isHidden) return
      await $.ui.open({ id: PANE, title: 'Context' })
      await update($, isPaneOpen, () => true)
    })

    return next(e)
  })

  on('command.run', { command: 'context-meter' }, async $ => {
    await tick($)
    // Brings a closed band back; otherwise toggles the comparison pane.
    if (await read($, isBandHidden)) {
      await update($, isBandHidden, () => false)
      return { text: 'Context-raden visas igen.' }
    }
    const isOpen = !(await read($, isPaneOpen))
    await setPane($, isOpen)

    return { text: isOpen ? 'Context-panelen visas.' : 'Context-panelen dold.' }
  })

  // The pane's own close mark counts as hiding it.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, isPaneOpen, () => false).catch(() => undefined)
      if (e.origin.kind === 'person') await savePrefs($, { isHidden: true }).catch(() => undefined)
    }

    return result
  })

  // The band above the prompt: this session's fill, + for the comparison pane,
  // a close mark, and the compaction controls.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const table = $.ui.resolve(e)
    // The band is drawn on the terminal and desktop only, both with a Select.
    if (!('Select' in table)) return next(e)
    const { Box, Button, Select, Text } = table
    const self = await read($, selfId)
    const own = merge(await read($, beats), await read($, scanned), self).find(b => b.id === self)
    const isOpen = await read($, isPaneOpen)
    const isAuto = await read($, isAutoCompact)
    const isOptions = await read($, isOptionsOpen)
    const p = await read($, prefs)
    const request = (await read($, requests))[self]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>
              Context {own ? <Text color={colorFor(own.percent, p)}>{own.percent}%</Text> : '–'}
            </Text>
            <Button
              key="context-meter-compare"
              plain
              label={isOpen ? '−' : '+'}
              onPress={() => setPane($, !isOpen)}
            />
          </Box>
          <Button
            key="context-meter-close"
            role="dismiss"
            plain
            label="×"
            onPress={() => update($, isBandHidden, () => true)}
          />
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button
            key="context-meter-compact"
            label={request && isBusy(request) ? STATE_TEXT[request.state] : 'Compact now'}
            onPress={() => compactSelf($)}
          />
          <Button
            key="context-meter-auto"
            plain
            label={`${isAuto ? '☑' : '☐'} Auto-compact ${p.autoAt}%`}
            onPress={() => update($, isAutoCompact, was => !was)}
          />
          <Button
            key="context-meter-options"
            plain
            dimColor={!isOptions}
            label="⚙ Options"
            onPress={() => update($, isOptionsOpen, was => !was)}
          />
        </Box>
        {request && !isBusy(request) && (
          <Text dimColor wrap="truncate-end">
            {STATE_TEXT[request.state]}
            {request.note ? ` – ${request.note}` : ''}
          </Text>
        )}
        {isOptions && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Options – gäller alla sessioner (bockrutan gäller bara den här)</Text>
            <Select
              key="context-meter-opt-auto-at"
              label="Auto-compact vid "
              options={percentOptions(COMPACT_STEPS, p.autoAt)}
              value={String(p.autoAt)}
              onSelect={v => void savePrefs($, { autoAt: Number(v) })}
            />
            <Select
              key="context-meter-opt-auto-new"
              label="Auto-compact påslaget i nya sessioner "
              options={YES_NO}
              value={yesNo(p.autoInNewSessions)}
              onSelect={v => void savePrefs($, { autoInNewSessions: v === 'yes' })}
            />
            <Select
              key="context-meter-opt-button-at"
              label="[Compact]-knapp i panelen från "
              options={percentOptions(COMPACT_STEPS, p.buttonAt)}
              value={String(p.buttonAt)}
              onSelect={v => void savePrefs($, { buttonAt: Number(v) })}
            />
            <Select
              key="context-meter-opt-yellow"
              label="Gul från "
              options={percentOptions(YELLOW_STEPS, p.yellowAt)}
              value={String(p.yellowAt)}
              onSelect={v => void savePrefs($, { yellowAt: Number(v) })}
            />
            <Select
              key="context-meter-opt-red"
              label="Röd över "
              options={percentOptions(RED_STEPS, p.redAt)}
              value={String(p.redAt)}
              onSelect={v => void savePrefs($, { redAt: Number(v) })}
            />
            <Select
              key="context-meter-opt-active"
              label="Visa sessioner aktiva senaste "
              options={percentOptions(MINUTE_STEPS, p.activeMinutes, ' min')}
              value={String(p.activeMinutes)}
              onSelect={v => void savePrefs($, { activeMinutes: Number(v) }).then(() => scan($))}
            />
            <Select
              key="context-meter-opt-estimated"
              label="Visa sessioner utan moddet (≈) "
              options={YES_NO}
              value={yesNo(p.showEstimated)}
              onSelect={v => void savePrefs($, { showEstimated: v === 'yes' })}
            />
            <Select
              key="context-meter-opt-pane"
              label="Öppna jämförelsepanelen vid start "
              options={YES_NO}
              value={yesNo(!p.isHidden)}
              onSelect={v => void savePrefs($, { isHidden: v === 'no' })}
            />
            <Box flexDirection="row" gap={2}>
              <Button
                key="context-meter-opt-reset"
                label="Återställ standard"
                onPress={() => savePrefs($, { ...DEFAULT_PREFS, isHidden: p.isHidden })}
              />
              <Button
                key="context-meter-opt-done"
                label="Klar"
                onPress={() => update($, isOptionsOpen, () => false)}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, isAwaitingSummary))) {
      const messages = await $.session.messages()
      const lastPrompt = [...messages].reverse().find(m => m.role === 'user' && m.text.trim() !== '')
      if (lastPrompt?.text.includes(SUMMARY_MARKER)) {
        await update($, isAwaitingSummary, () => false)
        const id = await $.session.id()
        const summary = toInstructions(e.answer)
        if (e.isAborted || summary === '') {
          await writeRequest($, id, 'failed', e.isAborted ? 'sammanfattningen avbröts' : 'tom sammanfattning')
        } else {
          await writeRequest($, id, 'compacting')
          $.clock.after(2_000, () => void compactWith($, summary, 1))
        }
      }
    }
    await tick($)

    return result
  })

  on('session.end', async ($, e, next) => {
    await beat($, true).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const self = await read($, selfId)
    const p = await read($, prefs)
    const list = merge(await read($, beats), await read($, scanned), self, p.showEstimated)
    const top = list[0]
    const asked = await read($, requests)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 40
    // Narrower than the pane: a desktop draws wider glyphs than it reports.
    const barWidth = Math.max(10, Math.min(60, columns - 12))

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text dimColor wrap="truncate-end">
            [Compact] visas från {p.buttonAt}%
            {top ? ` · högst nu ${top.percent}%` : ''}
          </Text>
        </Box>
        {list.length === 0 && <Text dimColor>Inga aktiva sessioner just nu.</Text>}
        {list.map(b => {
          const filled = Math.round((b.percent / 100) * barWidth)
          const request = asked[b.id]
          const canCompact = !b.isEstimated && b.percent >= p.buttonAt && !isBusy(request)
          return (
            <Box key={b.id} flexDirection="column" marginBottom={1}>
              <Text bold={b.id === self} dimColor={b.isEstimated} wrap="truncate-end">
                {b.id === self ? '● ' : '  '}
                {b.label}
              </Text>
              <Text color={colorFor(b.percent, p)} wrap="truncate-end">
                {'█'.repeat(filled)}
                <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {b.isEstimated ? '≈' : ''}
                {b.percent}% · {kilo(b.tokens)} / {kilo(b.window)} · {folderName(b.cwd)}
              </Text>
              {request && (
                <Text dimColor wrap="truncate-end">
                  {STATE_TEXT[request.state]}
                  {request.note ? ` – ${request.note}` : ''}
                </Text>
              )}
              {canCompact && (
                <Button
                  key={`compact-${b.id}`}
                  label="Compact"
                  onPress={() => writeRequest($, b.id, 'requested')}
                />
              )}
              {b.isEstimated && b.percent >= p.buttonAt && (
                <Text dimColor>starta om sessionen för compact</Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
