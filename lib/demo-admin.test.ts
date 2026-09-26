import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROPOSAL_BPS,
  DEFAULT_PROPOSAL_PERCENT,
  DEFAULT_TIMELOCK_INPUT,
  DEFAULT_TIMELOCK_SECONDS,
  DEMO_ADMIN_TX_ERROR,
  NOT_DEMO_ADMIN_ERROR,
  demoAdminTxError,
  isDemoAdmin,
  parseTimelockSeconds,
} from "./demo-admin.ts";
import { parsePercentToBps } from "./position.ts";

test("Demo Admin defaults are 60% (6000 bps) and a 60-second Timelock", () => {
  assert.equal(DEFAULT_PROPOSAL_PERCENT, "60");
  assert.equal(DEFAULT_PROPOSAL_BPS, 6000n);
  assert.equal(DEFAULT_TIMELOCK_INPUT, "60");
  assert.equal(DEFAULT_TIMELOCK_SECONDS, 60n);
  // The 60% default must land on exactly 6000 bps, not 60 or 600000.
  assert.deepEqual(parsePercentToBps(DEFAULT_PROPOSAL_PERCENT), {
    ok: true,
    bps: DEFAULT_PROPOSAL_BPS,
  });
});

test("parseTimelockSeconds accepts whole positive seconds and trims input", () => {
  assert.deepEqual(parseTimelockSeconds("60"), { ok: true, seconds: 60n });
  assert.deepEqual(parseTimelockSeconds("120"), { ok: true, seconds: 120n });
  assert.deepEqual(parseTimelockSeconds("1"), { ok: true, seconds: 1n });
  assert.deepEqual(parseTimelockSeconds(" 90 "), { ok: true, seconds: 90n });
  assert.deepEqual(parseTimelockSeconds("604800"), { ok: true, seconds: 604800n });
});

test("parseTimelockSeconds rejects zero, negatives, decimals, and malformed input", () => {
  for (const bad of ["0", "-5", "1.5", "", "abc", "60s", "6e1", "1 2"]) {
    const result = parseTimelockSeconds(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("isDemoAdmin compares the owner to the connected wallet case-insensitively", () => {
  const owner = "0x1F23EbA427de7f924C1Af1e87D99fC797877e461";
  assert.equal(isDemoAdmin(owner, owner), true);
  assert.equal(isDemoAdmin(owner, owner.toLowerCase()), true);
  assert.equal(isDemoAdmin(owner.toLowerCase(), owner.toUpperCase()), true);
  // A different wallet is not the Demo Admin.
  assert.equal(isDemoAdmin(owner, "0x0000000000000000000000000000000000000001"), false);
  // Nothing connected / nothing read yet is never the Demo Admin.
  assert.equal(isDemoAdmin(owner, undefined), false);
  assert.equal(isDemoAdmin(undefined, owner), false);
  assert.equal(isDemoAdmin(undefined, undefined), false);
});

test("demoAdminTxError is friendly and never the raw revert", () => {
  const owner = "0x1F23EbA427de7f924C1Af1e87D99fC797877e461";
  const other = "0x0000000000000000000000000000000000000001";

  assert.equal(demoAdminTxError(owner, other), NOT_DEMO_ADMIN_ERROR);
  assert.equal(demoAdminTxError(owner, undefined), NOT_DEMO_ADMIN_ERROR);

  const ownerFailure = demoAdminTxError(owner, owner);
  assert.equal(ownerFailure, DEMO_ADMIN_TX_ERROR);
  assert.notEqual(ownerFailure, NOT_DEMO_ADMIN_ERROR);
  // No raw revert / selector / hex blob should ever be surfaced.
  assert.doesNotMatch(ownerFailure, /0x[0-9a-fA-F]+/);
  assert.doesNotMatch(ownerFailure, /revert/i);
});
