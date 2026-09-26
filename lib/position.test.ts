import assert from "node:assert/strict";
import test from "node:test";

import {
  bpsToCopy,
  collateralValueUsd,
  formatDecimal,
  healthStatus,
  maxBorrow,
  openPositionError,
  parsePercentToBps,
  parseTokenAmount,
  validateOpenPosition,
} from "./position.ts";

test("bpsToCopy renders integer basis points as percent copy", () => {
  assert.equal(bpsToCopy(8000n), "80%");
  assert.equal(bpsToCopy(10000n), "100%");
  assert.equal(bpsToCopy(0n), "0%");
  assert.equal(bpsToCopy(7050n), "70.5%");
  assert.equal(bpsToCopy(7010n), "70.1%");
  assert.equal(bpsToCopy(7001n), "70.01%");
  assert.equal(bpsToCopy(9999n), "99.99%");
  assert.equal(bpsToCopy(1n), "0.01%");
});

test("parsePercentToBps converts a percent string to integer basis points", () => {
  assert.deepEqual(parsePercentToBps("70"), { ok: true, bps: 7000n });
  assert.deepEqual(parsePercentToBps("70.5"), { ok: true, bps: 7050n });
  assert.deepEqual(parsePercentToBps("0.01"), { ok: true, bps: 1n });
  assert.deepEqual(parsePercentToBps("100"), { ok: true, bps: 10000n });
  assert.deepEqual(parsePercentToBps("100.00"), { ok: true, bps: 10000n });
});

test("parsePercentToBps rejects zero, over-100, too-precise, and malformed input", () => {
  for (const bad of ["0", "0.00", "100.01", "70.123", "", "abc", "-5", "7e1"]) {
    const result = parsePercentToBps(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("healthStatus compares the 1e18-scaled health factor to one", () => {
  assert.equal(healthStatus(1_000_000_000_000_000_000n), "SAFE");
  assert.equal(healthStatus(1_230_769_230_769_230_769n), "SAFE");
  assert.equal(healthStatus(999_999_999_999_999_999n), "UNSAFE");
  assert.equal(healthStatus(923_076_923_076_923_076n), "UNSAFE");
  // Debt of 0 reports type(uint256).max on chain; still SAFE.
  assert.equal(healthStatus(2n ** 256n - 1n), "SAFE");
});

test("collateralValueUsd prices Collateral at the fixed AVAX price", () => {
  // 10 AVAX at $20 = $200.
  assert.equal(collateralValueUsd(10n * 10n ** 18n, 20n * 10n ** 18n), 200n * 10n ** 18n);
  // 0.5 AVAX at $20 = $10.
  assert.equal(collateralValueUsd(5n * 10n ** 17n, 20n * 10n ** 18n), 10n * 10n ** 18n);
  assert.equal(collateralValueUsd(0n, 20n * 10n ** 18n), 0n);
});

test("maxBorrow caps Debt at collateralValue * threshold", () => {
  // 10 AVAX * $20 * 80% = $160.
  assert.equal(
    maxBorrow(10n * 10n ** 18n, 20n * 10n ** 18n, 8000n),
    160n * 10n ** 18n,
  );
  // 0.5 AVAX * $20 * 80% = $8.
  assert.equal(
    maxBorrow(5n * 10n ** 17n, 20n * 10n ** 18n, 8000n),
    8n * 10n ** 18n,
  );
});

test("parseTokenAmount reads a decimal token amount as integer base units", () => {
  assert.equal(parseTokenAmount("10"), 10_000_000_000_000_000_000n);
  assert.equal(parseTokenAmount("0.5"), 500_000_000_000_000_000n);
  assert.equal(parseTokenAmount("130"), 130_000_000_000_000_000_000n);
  assert.equal(parseTokenAmount("0.175"), 175_000_000_000_000_000n);
  assert.equal(parseTokenAmount("1.234567890123456789"), 1_234_567_890_123_456_789n);
  assert.equal(parseTokenAmount("0"), 0n);
});

test("parseTokenAmount rejects malformed and over-precise input", () => {
  for (const bad of ["", "abc", "1.2.3", "-1", "1.1234567890123456789"]) {
    assert.equal(parseTokenAmount(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("formatDecimal prints base units as a trimmed decimal", () => {
  assert.equal(formatDecimal(10_000_000_000_000_000_000n, 18), "10");
  assert.equal(formatDecimal(500_000_000_000_000_000n, 18), "0.5");
  assert.equal(formatDecimal(175_000_000_000_000_000n, 18), "0.175");
  assert.equal(formatDecimal(130_000_000_000_000_000_000n, 18), "130");
  assert.equal(formatDecimal(1_234_567_890_123_456_789n, 18), "1.234567890123456789");
  assert.equal(formatDecimal(0n, 18), "0");
  assert.equal(formatDecimal(1_000n, 6), "0.001");
});

test("validateOpenPosition accepts a Position inside the Liquidation threshold", () => {
  const base = {
    avaxPriceUsd: 20n * 10n ** 18n,
    liquidationThresholdBps: 8000n,
  };
  assert.equal(
    validateOpenPosition({ ...base, collateralWei: 10n * 10n ** 18n, borrowAmountWei: 130n * 10n ** 18n }).ok,
    true,
  );
  // Exactly at the ceiling is allowed (the pool compares with `>`).
  assert.equal(
    validateOpenPosition({ ...base, collateralWei: 10n * 10n ** 18n, borrowAmountWei: 160n * 10n ** 18n }).ok,
    true,
  );
});

test("validateOpenPosition rejects an empty Position and Debt above the ceiling", () => {
  const base = {
    avaxPriceUsd: 20n * 10n ** 18n,
    liquidationThresholdBps: 8000n,
  };
  const over = validateOpenPosition({
    ...base,
    collateralWei: 10n * 10n ** 18n,
    borrowAmountWei: 160n * 10n ** 18n + 1n,
  });
  assert.equal(over.ok, false);
  assert.equal(
    validateOpenPosition({ ...base, collateralWei: 0n, borrowAmountWei: 1n }).ok,
    false,
  );
});

test("a top-up includes existing debt after governance lowers the safety limit", () => {
  const result = validateOpenPosition({
    collateralWei: 20_000_000_000_000_000n,
    borrowAmountWei: 200_000_000_000_000_000n,
    existingCollateralWei: 10_000_000_000_000_000n,
    existingDebtWei: 150_000_000_000_000_000n,
    avaxPriceUsd: 20n * 10n ** 18n,
    liquidationThresholdBps: 5000n,
  });
  assert.deepEqual(result, {
    ok: false,
    error: "Total debt would be 0.35 mUSDC, above the 0.3 mUSDC limit for your combined collateral. Add more AVAX or borrow less.",
  });
});

test("existing collateral permits borrowing without another deposit up to the total ceiling", () => {
  const input = {
    collateralWei: 0n,
    borrowAmountWei: 50_000_000_000_000_000n,
    existingCollateralWei: 20_000_000_000_000_000n,
    existingDebtWei: 150_000_000_000_000_000n,
    avaxPriceUsd: 20n * 10n ** 18n,
    liquidationThresholdBps: 5000n,
  };
  assert.equal(validateOpenPosition(input).ok, true);
  assert.equal(validateOpenPosition({ ...input, borrowAmountWei: input.borrowAmountWei + 1n }).ok, false);
});

test("the wallet's raw collateral revert becomes an actionable message", () => {
  for (const message of [
    'Unable to calculate gas limit: execution reverted (unknown custom error) data="0x3a23d825"',
    'The contract function "openPosition" reverted: InsufficientCollateral()',
  ]) {
    assert.equal(openPositionError(new Error(message)),
      "Your combined collateral does not cover your existing debt plus this borrow at the current safety limit. Add more AVAX or borrow less.");
  }
});
