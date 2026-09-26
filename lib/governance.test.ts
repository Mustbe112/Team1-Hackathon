import assert from "node:assert/strict";
import test from "node:test";

import {
  avaxReturned,
  canExecuteProposal,
  explorerTxUrl,
  formatCountdown,
  formatThresholdChange,
  pickLatestLog,
  proposalStateLabel,
  remainingSeconds,
} from "./governance.ts";

test("formatCountdown renders mm:ss below an hour and hh:mm:ss above", () => {
  assert.equal(formatCountdown(60), "01:00");
  assert.equal(formatCountdown(47), "00:47");
  assert.equal(formatCountdown(9), "00:09");
  assert.equal(formatCountdown(0), "00:00");
  assert.equal(formatCountdown(-5), "00:00");
  assert.equal(formatCountdown(3599), "59:59");
  assert.equal(formatCountdown(3600), "01:00:00");
  assert.equal(formatCountdown(3661), "01:01:01");
});

test("remainingSeconds anchors on the on-chain clock and local elapsed time", () => {
  // executeAfter 1000s, on-chain now 940s -> 60s left.
  assert.equal(remainingSeconds(1000n, 940n, 0), 60);
  assert.equal(remainingSeconds(1000n, 940n, 29_999), 30);
  assert.equal(remainingSeconds(1000n, 940n, 30_000), 30);
  assert.equal(remainingSeconds(1000n, 940n, 60_000), 0);
  // Never goes negative, and an elapsed Timelock is 0.
  assert.equal(remainingSeconds(1000n, 940n, 90_000), 0);
  assert.equal(remainingSeconds(1000n, 1000n, 0), 0);
  assert.equal(remainingSeconds(900n, 1000n, 0), 0);
});

test("avaxReturned settles Debt against Collateral at the fixed price", () => {
  const price = 20n * 10n ** 18n;
  // 10 AVAX / 130 mUSDC -> debt costs 6.5 AVAX, 3.5 AVAX returns.
  assert.equal(
    avaxReturned(10n * 10n ** 18n, 130n * 10n ** 18n, price),
    3_500_000_000_000_000_000n,
  );
  // Scaled live Position 0.3 AVAX / 3.9 mUSDC -> 0.105 AVAX returns.
  assert.equal(
    avaxReturned(300_000_000_000_000_000n, 3_900_000_000_000_000_000n, price),
    105_000_000_000_000_000n,
  );
  // 0.5 AVAX / 3.0 mUSDC -> 0.15 AVAX debt, 0.35 AVAX returns.
  assert.equal(
    avaxReturned(500_000_000_000_000_000n, 3_000_000_000_000_000_000n, price),
    350_000_000_000_000_000n,
  );
  // No Debt -> the whole Collateral returns.
  assert.equal(avaxReturned(10n * 10n ** 18n, 0n, price), 10n * 10n ** 18n);
  // Unreachable on a solvent exit; never render a negative remainder.
  assert.equal(avaxReturned(1n * 10n ** 18n, 30n * 10n ** 18n, price), 0n);
});

test("formatThresholdChange renders the queued change as bps copy", () => {
  assert.equal(formatThresholdChange(8000n, 6000n), "80% → 60%");
  assert.equal(formatThresholdChange(8000n, 8000n), "80% → 80%");
  assert.equal(formatThresholdChange(7050n, 7001n), "70.5% → 70.01%");
});

test("proposalStateLabel maps the ProposalState enum to copy", () => {
  assert.equal(proposalStateLabel(0), "None");
  assert.equal(proposalStateLabel(1), "Queued");
  assert.equal(proposalStateLabel(2), "Executed");
  assert.equal(proposalStateLabel(3), "Cancelled");
  assert.equal(proposalStateLabel(99), "Unknown");
});

test("pickLatestLog selects by block then log index and handles none", () => {
  const logs = [
    { blockNumber: 100n, logIndex: 0, tag: "a" },
    { blockNumber: 102n, logIndex: 1, tag: "b" },
    { blockNumber: 102n, logIndex: 3, tag: "c" },
    { blockNumber: 101n, logIndex: 5, tag: "d" },
  ];
  assert.equal(pickLatestLog(logs)?.tag, "c");
  assert.equal(pickLatestLog([]), null);
  // A pending (null-block) log never outranks a mined one.
  assert.equal(
    pickLatestLog([
      { blockNumber: null, logIndex: 9, tag: "pending" },
      { blockNumber: 1n, logIndex: 0, tag: "mined" },
    ])?.tag,
    "mined",
  );
});

test("explorerTxUrl builds a Fuji transaction link", () => {
  assert.equal(
    explorerTxUrl("https://testnet.snowtrace.io", "0x83d"),
    "https://testnet.snowtrace.io/tx/0x83d",
  );
  assert.equal(
    explorerTxUrl("https://testnet.snowtrace.io/", "0x83d"),
    "https://testnet.snowtrace.io/tx/0x83d",
  );
});

// The governance contract permits execution only for queued proposals once
// the latest on-chain block reaches the timelock, regardless of local time.
test("a queued proposal becomes executable at the on-chain deadline only", () => {
  assert.equal(canExecuteProposal(1, 1000n, 999n), false);
  assert.equal(canExecuteProposal(1, 1000n, 1000n), true);
  assert.equal(canExecuteProposal(1, 1000n, 1001n), true);
  for (const state of [0, 2, 3, undefined]) {
    assert.equal(canExecuteProposal(state, 1000n, 1001n), false);
  }
  assert.equal(canExecuteProposal(1, undefined, 1001n), false);
  assert.equal(canExecuteProposal(1, 1000n, undefined), false);
});
