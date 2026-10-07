/** One session's context fill: from its own heartbeat, or estimated from its transcript. */
export type ContextBeat = {
  id: string
  label: string
  cwd: string
  model: string
  tokens: number
  window: number
  percent: number
  updatedAt: number
  isEnded: boolean
  isEstimated?: boolean
}

/** Where a requested compaction of one session stands. */
export type CompactState = 'requested' | 'summarizing' | 'compacting' | 'done' | 'failed'

/** A compaction the pane asked for, kept in requests/<session id>.json. */
export type CompactRequest = {
  state: CompactState
  at: number
  note?: string
}

/** The options, shared by every session, in prefs.json. */
export type MeterPrefs = {
  /** The comparison pane starts closed. */
  isHidden: boolean
  /** Auto-compact fires at this fill. */
  autoAt: number
  /** The pane's per-session [Compact] shows from this fill. */
  buttonAt: number
  /** Below this fill green; up to and including redAt yellow; above, red. */
  yellowAt: number
  redAt: number
  /** Sessions whose transcript was written within this window are listed. */
  activeMinutes: number
  /** List sessions that do not run the mod, estimated from their transcript. */
  showEstimated: boolean
  /** A new session starts with its auto-compact box ticked. */
  autoInNewSessions: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      beats: ContextBeat[]
      scanned: ContextBeat[]
      selfId: string
      requests: Record<string, CompactRequest>
      isAwaitingSummary: boolean
      isPaneOpen: boolean
      isBandHidden: boolean
      isAutoCompact: boolean
      isOptionsOpen: boolean
      prefs: MeterPrefs
    }
  }
}
