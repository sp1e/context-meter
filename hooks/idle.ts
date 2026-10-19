// Pure code, no engine: decides whether an idle session should compact now.

// The API keeps the prompt cache for an hour. A prompt after that writes the
// whole context into the cache again, at twice the input price. Compacting
// before the hour ends reads the context from a warm cache instead.
export const CACHE_TTL_MS = 60 * 60_000

export type IdleInput = {
  /** Minutes without a turn before compacting; 0 turns it off. */
  idleMinutes: number
  /** Smaller contexts are left alone. */
  minTokens: number
  /** When the last main turn ended; 0 when none has run since the session started. */
  lastTurnAt: number
  now: number
  tokens: number
  /** When this session's latest compaction request was written, if any. */
  lastRequestAt?: number
  isRequestBusy: boolean
}

export function isIdleCompactDue(i: IdleInput): boolean {
  if (i.idleMinutes <= 0 || i.lastTurnAt === 0 || i.isRequestBusy) return false
  const idleMs = i.now - i.lastTurnAt
  if (idleMs < i.idleMinutes * 60_000 || idleMs >= CACHE_TTL_MS) return false
  if (i.tokens < i.minTokens) return false
  // A request written after the last turn already covers this idle stretch.
  return i.lastRequestAt === undefined || i.lastRequestAt <= i.lastTurnAt
}

// Cache Tax: what the band says about the prompt cache while the session waits.
// From WARN_MS of idle it counts down; once the hour has passed, the next prompt
// writes the whole context into the cache again.
export const CACHE_WARN_MS = 40 * 60_000

export type CacheStatus =
  | { kind: 'warm' }
  | { kind: 'expiring'; minutesLeft: number; tokens: number }
  | { kind: 'cold'; tokens: number }

export function cacheStatus(i: { lastTurnAt: number; now: number; tokens: number; isRunning: boolean }): CacheStatus {
  if (i.lastTurnAt === 0 || i.isRunning || i.tokens <= 0) return { kind: 'warm' }
  const idleMs = i.now - i.lastTurnAt
  if (idleMs >= CACHE_TTL_MS) return { kind: 'cold', tokens: i.tokens }
  if (idleMs >= CACHE_WARN_MS) {
    return { kind: 'expiring', minutesLeft: Math.ceil((CACHE_TTL_MS - idleMs) / 60_000), tokens: i.tokens }
  }
  return { kind: 'warm' }
}
