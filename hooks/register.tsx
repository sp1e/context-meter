import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CompactRequest, CompactState, ContextBeat, MeterPrefs } from '../types'
import { cacheStatus, isIdleCompactDue } from './idle'

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
  idleMinutes: 55,
  idleMinTokens: 150_000,
}

// What the options' pickers offer; a stored value outside them is added.
const COMPACT_STEPS = [30, 40, 50, 60, 70, 80, 90]
const YELLOW_STEPS = [30, 40, 50, 60, 70, 80]
const RED_STEPS = [50, 60, 70, 75, 80, 90, 95]
const MINUTE_STEPS = [5, 10, 30, 60, 240]
const IDLE_STEPS = [0, 30, 45, 55]
const TOKEN_STEPS = [100_000, 150_000, 200_000, 250_000]


// Steers every compaction that arrives without instructions of its own: the
// engine's auto-compact at its threshold, a bare /compact, and a precompute.
const COMPACT_INSTRUCTIONS = [
  'Skriv sammanfattningen så att en ny session kan fortsätta utan att fråga något. Skriv på samtalets språk.',
  'Använd exakt dessa rubriker, i den här ordningen:',
  'LÄGE: en mening om vad som pågår just nu och om något arbete är halvfärdigt.',
  'GJORT: det som är klart och verifierat, med uppmätta tal och hur det verifierades.',
  'BESLUT: vad användaren har bestämt, med användarens egna ord där de spelar roll, och vad som väntar på beslut.',
  'FILER: fullständiga sökvägar till varje fil som skapats eller ändrats, säkerhetskopior, grenar, commits och PR-länkar.',
  'FEL OCH LÖSNINGAR: fel som uppstod, orsaken och vad som löste dem, så att de inte upprepas. ' +
    'Citera den avgörande felraden ordagrant inom backticks, så att hela utskriften kan sökas fram i transkriptet.',
  'NÄSTA STEG: numrerade, i den ordning de ska göras.',
  'FAST: regler och rättelser användaren gett i sessionen som ska gälla framåt.',
  'Ta med exakta namn, id:n, kommandon och tal. Utelämna resonemang och mellansteg som inte påverkar fortsättningen.',
].join('\n')

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
const isPaneOpen = atom({ plugin: 'context-meter', key: 'isPaneOpen' } as const, false)
// Both per session: the band's close mark, and the auto-compact box.
const isBandHidden = atom({ plugin: 'context-meter', key: 'isBandHidden' } as const, false)
const isAutoCompact = atom({ plugin: 'context-meter', key: 'isAutoCompact' } as const, false)
const isOptionsOpen = atom({ plugin: 'context-meter', key: 'isOptionsOpen' } as const, false)
const prefs = atom({ plugin: 'context-meter', key: 'prefs' } as const, DEFAULT_PREFS)
// When this session's last main turn ended (0: none since the session started), and whether one runs now.
const lastTurnAt = atom({ plugin: 'context-meter', key: 'lastTurnAt' } as const, 0)
const isTurnRunning = atom({ plugin: 'context-meter', key: 'isTurnRunning' } as const, false)
// After a failed or finished compaction, auto-compact waits this long.
const AUTO_PAUSE_MS = 10 * 60_000

// The meter's palette: mint, sun and coral for the three zones, periwinkle for
// auto-compact. Raw hex reads on both a dark and a light theme.
const MINT = '#2EC4A0'
const SUN = '#F5B83D'
const CORAL = '#F26D6D'
const PERIWINKLE = '#8B8FF7'
const GAUGE_CELLS = 12

// Mint below yellowAt, sun up to and including redAt, coral above.
function colorFor(percent: number, p: MeterPrefs): string {
  if (percent < p.yellowAt) return MINT
  if (percent <= p.redAt) return SUN
  return CORAL
}

type GaugeCell = { glyph: string; color?: string; isFilled: boolean }

// The band's meter: filled cells take the colour of the zone they sit in, and a
// tick marks where auto-compact fires while this session's box is ticked.
function gauge(percent: number, p: MeterPrefs, autoAt?: number): GaugeCell[] {
  const cells: GaugeCell[] = []
  for (let i = 0; i < GAUGE_CELLS; i++) {
    const at = ((i + 0.5) / GAUGE_CELLS) * 100
    if (autoAt !== undefined && Math.round((autoAt / 100) * GAUGE_CELLS) === i) {
      cells.push({ glyph: '┃', color: PERIWINKLE, isFilled: true })
    }
    const isFilled = percent >= at
    cells.push({ glyph: isFilled ? '▰' : '▱', color: isFilled ? colorFor(at, p) : undefined, isFilled })
  }
  return cells
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
    idleMinutes: numberOr(p.idleMinutes, d.idleMinutes),
    idleMinTokens: numberOr(p.idleMinTokens, d.idleMinTokens),
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

function idleOptions(current: number) {
  return [...new Set([...IDLE_STEPS, current])]
    .sort((a, b) => a - b)
    .map(n => ({ value: String(n), label: n === 0 ? 'av' : `${n} min` }))
}

function tokenOptions(current: number) {
  return [...new Set([...TOKEN_STEPS, current])]
    .sort((a, b) => a - b)
    .map(n => ({ value: String(n), label: `${n / 1000}k` }))
}

const kilo = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const isBusy = (r: CompactRequest | undefined) =>
  r !== undefined && (r.state === 'requested' || r.state === 'compacting')

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

// The compaction's summary is the first message of the conversation it leaves.
// Saved as compacts/<date>_<session id>.md, one file per compaction.
async function archiveSummary(
  $: EngineInterface,
  id: string,
  trigger: string,
  result: { messages?: readonly { text: string }[]; tokensBefore?: number; tokensAfter?: number },
): Promise<void> {
  const summary = result.messages?.[0]?.text?.trim()
  if (!summary) return
  const at = new Date(await $.clock.now())
  const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const cwd = await $.session.cwd()
  const tokens =
    result.tokensBefore !== undefined
      ? `${Math.round(result.tokensBefore / 1000)}k → ${Math.round((result.tokensAfter ?? 0) / 1000)}k tokens`
      : ''
  const header = [
    `# Compact ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `- Session: ${label || folderName(cwd)} (\`${id}\`)`,
    `- Mapp: \`${cwd}\``,
    `- Utlöst av: ${trigger}${tokens ? `, ${tokens}` : ''}`,
    '',
  ].join('\n')
  await $.fs.write(`${await heartbeatDir($)}/compacts/${stamp}_${id}.md`, `${header}\n${summary}\n`)
}

// In the target session: a requested compaction runs at once with the
// structured instructions, one model call over the context.
async function takeRequest($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const request = (await read($, requests))[id]
  if (request?.state !== 'requested') return
  await writeRequest($, id, 'compacting', request.note)
  void compactWith($, COMPACT_INSTRUCTIONS, 1)
}

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 160)

// Compaction is refused while
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
      // Last resort: paste `/compact <text>` as if typed; it runs once idle.
      try {
        await $.prompt.submit({ text: `/compact ${instructions}`, asUser: true })
        await writeRequest($, id, 'compacting', 'inklistrat som /compact, körs när sessionen är ledig')
      } catch (pasted) {
        const notes = [errorText(error), `/compact: ${errorText(fallback)}`, `inklistring: ${errorText(pasted)}`]
        await writeRequest($, id, 'failed', notes.join(' | '))
      }
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

// Idle compact: see idle.ts. Once per idle stretch: a request made after the last turn ends it.
async function idleCompact($: EngineInterface): Promise<void> {
  const [p, last, isRunning] = await Promise.all([read($, prefs), read($, lastTurnAt), read($, isTurnRunning)])
  if (p.idleMinutes <= 0 || last === 0 || isRunning) return
  const [id, usage, now] = await Promise.all([$.session.id(), $.session.usage(), $.clock.now()])
  const request = (await read($, requests))[id]
  const due = isIdleCompactDue({
    idleMinutes: p.idleMinutes,
    minTokens: p.idleMinTokens,
    lastTurnAt: last,
    now,
    tokens: usage.context.tokens ?? 0,
    lastRequestAt: request?.at,
    isRequestBusy: isBusy(request),
  })
  if (due) await writeRequest($, id, 'requested', `inaktiv i ${Math.round((now - last) / 60_000)} min`)
}

async function tick($: EngineInterface): Promise<void> {
  await loadPrefs($).catch(() => undefined)
  await beat($).catch(() => undefined)
  await refresh($).catch(() => undefined)
  await autoCompact($).catch(() => undefined)
  await idleCompact($).catch(() => undefined)
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
    const cache = cacheStatus({
      lastTurnAt: await read($, lastTurnAt),
      now: await $.clock.now(),
      tokens: own?.tokens ?? 0,
      isRunning: await read($, isTurnRunning),
    })

    const percent = own?.percent
    const cells = percent === undefined ? [] : gauge(percent, p, isAuto ? p.autoAt : undefined)

    // Options in three short rows: compaction, colours, the comparison pane.
    const optionsPanel = (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Text bold color={PERIWINKLE}>Compact</Text>
          <Select
            key="context-meter-opt-auto-at"
            label="Custom autocomp. vid "
            options={percentOptions(COMPACT_STEPS, p.autoAt)}
            value={String(p.autoAt)}
            onSelect={v => void savePrefs($, { autoAt: Number(v) })}
          />
          <Select
            key="context-meter-opt-auto-new"
            label="på i nya sessioner "
            options={YES_NO}
            value={yesNo(p.autoInNewSessions)}
            onSelect={v => void savePrefs($, { autoInNewSessions: v === 'yes' })}
          />
          <Select
            key="context-meter-opt-idle"
            label="vid inaktivitet efter "
            options={idleOptions(p.idleMinutes)}
            value={String(p.idleMinutes)}
            onSelect={v => void savePrefs($, { idleMinutes: Number(v) })}
          />
          <Select
            key="context-meter-opt-idle-tokens"
            label="om kontexten är minst "
            options={tokenOptions(p.idleMinTokens)}
            value={String(p.idleMinTokens)}
            onSelect={v => void savePrefs($, { idleMinTokens: Number(v) })}
          />
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Text bold color={SUN}>Färger</Text>
          <Select
            key="context-meter-opt-yellow"
            label="gul från "
            options={percentOptions(YELLOW_STEPS, p.yellowAt)}
            value={String(p.yellowAt)}
            onSelect={v => void savePrefs($, { yellowAt: Number(v) })}
          />
          <Select
            key="context-meter-opt-red"
            label="röd över "
            options={percentOptions(RED_STEPS, p.redAt)}
            value={String(p.redAt)}
            onSelect={v => void savePrefs($, { redAt: Number(v) })}
          />
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Text bold color={MINT}>Panelen</Text>
          <Select
            key="context-meter-opt-pane"
            label="öppen vid start "
            options={YES_NO}
            value={yesNo(!p.isHidden)}
            onSelect={v => void savePrefs($, { isHidden: v === 'no' })}
          />
          <Select
            key="context-meter-opt-active"
            label="sessioner aktiva senaste "
            options={percentOptions(MINUTE_STEPS, p.activeMinutes, ' min')}
            value={String(p.activeMinutes)}
            onSelect={v => void savePrefs($, { activeMinutes: Number(v) }).then(() => scan($))}
          />
          <Select
            key="context-meter-opt-button-at"
            label="[Compact] från "
            options={percentOptions(COMPACT_STEPS, p.buttonAt)}
            value={String(p.buttonAt)}
            onSelect={v => void savePrefs($, { buttonAt: Number(v) })}
          />
          <Select
            key="context-meter-opt-estimated"
            label="sessioner utan moddet (≈) "
            options={YES_NO}
            value={yesNo(p.showEstimated)}
            onSelect={v => void savePrefs($, { showEstimated: v === 'yes' })}
          />
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Text dimColor>Gäller alla sessioner. Bocken gäller bara den här.</Text>
          <Box flexGrow={1} />
          <Button
            key="context-meter-opt-reset"
            plain
            dimColor
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
    )

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Each group reads like the meter: a dim caption with a bold value on
            top, the control underneath. The desktop draws a Button's label in its
            own type and drops Text children, so the styled text sits above it. */}
        <Box flexDirection="row" alignItems="flex-end" columnGap={4}>
          <Box flexDirection="column">
            <Text>
              <Text dimColor>Context </Text>
              <Text bold color={percent === undefined ? undefined : colorFor(percent, p)}>
                {percent === undefined ? '–' : `${percent}%`}
              </Text>
            </Text>
            <Text>
              {cells.map(c => (
                <Text color={c.color} dimColor={!c.isFilled}>
                  {c.glyph}
                </Text>
              ))}
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Sessioner</Text>
            <Button
              key="context-meter-compare"
              plain
              dimColor={!isOpen}
              label={isOpen ? 'Dölj ▴' : 'Jämför ▾'}
              onPress={() => setPane($, !isOpen)}
            />
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Manuellt</Text>
            <Button
              key="context-meter-compact"
              variant="primary"
              label={request && isBusy(request) ? `${STATE_TEXT[request.state]} …` : 'Compact now'}
              onPress={() => compactSelf($)}
            />
          </Box>
          <Box flexDirection="column">
            <Text>
              <Text dimColor>Custom autocomp. </Text>
              <Text bold color={isAuto ? PERIWINKLE : undefined} dimColor={!isAuto}>
                {p.autoAt}%
              </Text>
            </Text>
            <Button
              key="context-meter-auto"
              plain
              dimColor={!isAuto}
              label={isAuto ? '◉ På' : '○ Av'}
              onPress={() => update($, isAutoCompact, was => !was)}
            />
          </Box>
          <Box flexGrow={1} />
          <Button
            key="context-meter-options"
            plain
            dimColor={!isOptions}
            label="⚙"
            onPress={() => update($, isOptionsOpen, was => !was)}
          />
          <Button
            key="context-meter-close"
            role="dismiss"
            plain
            dimColor
            label="×"
            onPress={() => update($, isBandHidden, () => true)}
          />
        </Box>
        {cache.kind === 'cold' && (
          <Text key="context-meter-cache" color={SUN} wrap="truncate-end">
            ◷ Cachen har gått ut: nästa prompt skriver om ~{kilo(cache.tokens)} tokens till cachen
          </Text>
        )}
        {cache.kind === 'expiring' && (
          <Text key="context-meter-cache" dimColor wrap="truncate-end">
            ◷ Cachen går ut om {cache.minutesLeft} min (~{kilo(cache.tokens)} tokens)
          </Text>
        )}
        {request && !isBusy(request) && (
          <Text wrap="truncate-end">
            <Text color={request.state === 'failed' ? CORAL : MINT}>
              {request.state === 'failed' ? '✕ ' : '✓ '}
            </Text>
            <Text dimColor>
              {STATE_TEXT[request.state]}
              {request.note ? ` – ${request.note}` : ''}
            </Text>
          </Text>
        )}
        {isOptions && optionsPanel}
      </Box>
    )
  })

  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, isTurnRunning, () => false)
      await update($, lastTurnAt, () => now)
    }
    await tick($)

    return result
  })

  // However the compaction ran (call, command or pasted /compact), a request
  // waiting on it is done once it stands.
  // A compaction without instructions gets the structured ones, and every
  // summary that stands is archived under compacts/ for later sessions.
  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const steered = isMain && !e.instructions?.trim() ? { ...e, instructions: COMPACT_INSTRUCTIONS } : e
    const result = await next(steered)
    const isSkipped = 'skip' in result && result.skip !== undefined
    const id = await $.session.id()
    if (!isSkipped && isMain && e.trigger !== 'precompute') {
      await archiveSummary($, id, e.trigger, result).catch(() => undefined)
    }
    const request = (await read($, requests))[id]
    if (!isSkipped && request?.state === 'compacting') {
      await writeRequest($, id, 'done').catch(() => undefined)
      $.clock.after(2_000, () => void beat($).catch(() => undefined))
    }

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
