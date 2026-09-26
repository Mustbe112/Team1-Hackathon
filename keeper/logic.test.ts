import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  backoffDelayMs,
  decideExit,
  isActionable,
  planChunks,
  type RuleState,
} from './logic.ts'

const rule = (over: Partial<RuleState> = {}): RuleState => ({
  minimumThresholdBps: 7000n,
  active: true,
  triggered: false,
  ...over,
})

test('planChunks: a range larger than maxSpan splits into complete, ordered chunks', () => {
  const chunks = planChunks(100n, 2250n, 1000n)
  assert.deepEqual(chunks, [
    { fromBlock: 100n, toBlock: 1099n },
    { fromBlock: 1100n, toBlock: 2099n },
    { fromBlock: 2100n, toBlock: 2250n },
  ])
  for (const c of chunks) {
    assert.ok(c.toBlock - c.fromBlock + 1n <= 1000n, 'chunk must not exceed maxSpan')
  }
  assert.equal(chunks[0].fromBlock, 100n)
  assert.equal(chunks[chunks.length - 1].toBlock, 2250n)
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].fromBlock, chunks[i - 1].toBlock + 1n, 'no gap or overlap')
  }
})

test('planChunks: a range that fits stays a single chunk', () => {
  assert.deepEqual(planChunks(58722211n, 58722250n, 5000n), [
    { fromBlock: 58722211n, toBlock: 58722250n },
  ])
})

test('planChunks: an empty or inverted range yields no chunks', () => {
  assert.deepEqual(planChunks(10n, 10n, 1000n), [{ fromBlock: 10n, toBlock: 10n }])
  assert.deepEqual(planChunks(11n, 10n, 1000n), [])
})

test('planChunks: a non-positive span is rejected rather than looping forever', () => {
  assert.throws(() => planChunks(0n, 10n, 0n))
})

test('isActionable: only an active, untriggered rule may act', () => {
  assert.equal(isActionable(rule()), true)
  assert.equal(isActionable(rule({ active: false })), false)
  assert.equal(isActionable(rule({ triggered: true })), false)
  assert.equal(isActionable(rule({ active: false, triggered: true })), false)
})

test('decideExit: requires BOTH an actionable rule and a true predicate', () => {
  assert.equal(decideExit(rule(), true), true)
  assert.equal(decideExit(rule(), false), false)
  // Proof the decision is the Keeper's limited gate: a firing predicate on an
  // already-Triggered rule must NOT be treated as actionable.
  assert.equal(decideExit(rule({ triggered: true }), true), false)
  assert.equal(decideExit(rule({ active: false }), true), false)
})

test('backoffDelayMs: grows exponentially and caps on HTTP 429 pressure', () => {
  assert.equal(backoffDelayMs(0, 500, 15000), 500)
  assert.equal(backoffDelayMs(1, 500, 15000), 1000)
  assert.equal(backoffDelayMs(2, 500, 15000), 2000)
  assert.equal(backoffDelayMs(10, 500, 15000), 15000)
})
