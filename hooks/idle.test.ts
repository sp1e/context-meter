import { expect, test } from 'claude-code/testing'

import { CACHE_TTL_MS, isIdleCompactDue } from './idle'

const MIN = 60_000
const base = {
  idleMinutes: 55,
  minTokens: 150_000,
  lastTurnAt: 1_000_000,
  now: 1_000_000 + 56 * MIN,
  tokens: 300_000,
  isRequestBusy: false,
}

test('en stor session som legat still 55–60 min kompakteras', async () => {
  expect(isIdleCompactDue(base)).toBe(true)
  expect(isIdleCompactDue({ ...base, now: base.lastTurnAt + 55 * MIN })).toBe(true)
})

test('för kort paus, kall cache eller liten kontext ger ingen compact', async () => {
  expect(isIdleCompactDue({ ...base, now: base.lastTurnAt + 54 * MIN })).toBe(false)
  expect(isIdleCompactDue({ ...base, now: base.lastTurnAt + CACHE_TTL_MS })).toBe(false)
  expect(isIdleCompactDue({ ...base, tokens: 149_999 })).toBe(false)
})

test('avslaget, ingen tur sedan start eller pågående begäran ger ingen compact', async () => {
  expect(isIdleCompactDue({ ...base, idleMinutes: 0 })).toBe(false)
  expect(isIdleCompactDue({ ...base, lastTurnAt: 0, now: 56 * MIN })).toBe(false)
  expect(isIdleCompactDue({ ...base, isRequestBusy: true })).toBe(false)
})

test('en gång per paus: en begäran efter senaste turen stoppar nästa', async () => {
  expect(isIdleCompactDue({ ...base, lastRequestAt: base.lastTurnAt + 55 * MIN })).toBe(false)
  expect(isIdleCompactDue({ ...base, lastRequestAt: base.lastTurnAt - MIN })).toBe(true)
})
