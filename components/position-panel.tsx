"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { readContract, waitForTransactionReceipt, writeContract } from "viem/actions";
import { avalancheFuji } from "wagmi/chains";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { StepCard } from "@/components/step-card";
import { govExitAbi, mockLendingPoolAbi } from "@/lib/abis";
import { env } from "@/lib/env";
import {
  bpsToCopy,
  collateralValueUsd,
  formatDecimal,
  healthStatus,
  maxBorrow,
  parsePercentToBps,
  parseTokenAmount,
  validateOpenPosition,
} from "@/lib/position";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-mono text-slate-200">{value}</dd>
    </div>
  );
}

/**
 * Step 1 (open a Position) and step 2 (set the Exit rule) — issue 13.
 *
 * Reads the Position, the pool's Liquidation threshold, the health factor, the
 * user's Exit rule, and the Exit-agent approval straight from Fuji with viem
 * `readContract`. `setRule` is only reachable through a flow that sends the
 * `approveExitAgent` transaction first, so a rule can never be created without
 * approval. All thresholds are integer basis points; formatting happens here.
 */
export function PositionPanel() {
  const pool = env.addresses.lendingPool;
  const govExit = env.addresses.govExit;
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { address, chain } = useAccount();
  const queryClient = useQueryClient();

  const readReady = Boolean(publicClient && address && pool && govExit);
  const onFuji = chain?.id === avalancheFuji.id;
  const writeReady = Boolean(walletClient && address && pool && govExit && onFuji);

  const positionQuery = useQuery({
    queryKey: ["govexit", "position", address],
    enabled: readReady,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "positions",
        args: [address!],
      }),
  });
  const thresholdQuery = useQuery({
    queryKey: ["govexit", "liquidationThresholdBps", address],
    enabled: readReady,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "liquidationThresholdBps",
      }),
  });
  const healthQuery = useQuery({
    queryKey: ["govexit", "healthFactor", address],
    enabled: readReady,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "healthFactor",
        args: [address!],
      }),
  });
  const priceQuery = useQuery({
    queryKey: ["govexit", "avaxPriceUsd", address],
    enabled: readReady,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "AVAX_PRICE_USD",
      }),
  });
  const ruleQuery = useQuery({
    queryKey: ["govexit", "rule", address],
    enabled: readReady,
    queryFn: () =>
      readContract(publicClient!, {
        address: govExit!,
        abi: govExitAbi,
        functionName: "rules",
        args: [address!],
      }),
  });
  const approvalQuery = useQuery({
    queryKey: ["govexit", "exitAgentApproval", address],
    enabled: readReady,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "exitAgents",
        args: [address!, govExit!],
      }),
  });

  const [percent, setPercent] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCollateral, setOpenCollateral] = useState("");
  const [openBorrow, setOpenBorrow] = useState("");

  const position = positionQuery.data;
  const collateral = position?.[0] ?? 0n;
  const debt = position?.[1] ?? 0n;
  const active = position?.[2] ?? false;

  const thresholdBps = thresholdQuery.data;
  const avaxPriceUsd = priceQuery.data;
  const usdValue =
    avaxPriceUsd !== undefined ? collateralValueUsd(collateral, avaxPriceUsd) : undefined;
  const status = healthQuery.data !== undefined ? healthStatus(healthQuery.data) : undefined;

  // "You can borrow up to …" preview for the amounts currently typed in step 1.
  const enteredCollateral = parseTokenAmount(openCollateral);
  const borrowLimit =
    enteredCollateral !== null && avaxPriceUsd !== undefined && thresholdBps !== undefined
      ? maxBorrow(enteredCollateral, avaxPriceUsd, thresholdBps)
      : undefined;

  const rule = ruleQuery.data;
  const ruleMinimumBps = rule?.[0];
  const ruleActive = rule?.[1] === true;
  const ruleTriggered = rule?.[2] === true;
  const approved = approvalQuery.data === true;
  const approvalRevoked = ruleActive && !approved;
  const protectionActive = ruleActive && approved && !ruleTriggered;

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["govexit"] });
  }

  async function handleSetRule(event: FormEvent) {
    event.preventDefault();
    const parsed = parsePercentToBps(percent);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!writeReady || !walletClient || !publicClient || !pool || !govExit) {
      setError("Connect your wallet to Avalanche Fuji to set a rule.");
      return;
    }
    setError(null);
    try {
      if (!approved) {
        // AC: a rule can never be created through the UI without approval. `setRule`
        // also reverts on-chain unless this approval is already in place.
        setBusy("Approving GovExit as your exit agent…");
        const approveHash = await writeContract(walletClient, {
          address: pool,
          abi: mockLendingPoolAbi,
          functionName: "approveExitAgent",
          args: [govExit, true],
        });
        await waitForTransactionReceipt(publicClient, { hash: approveHash });
      }
      setBusy("Saving your protection rule…");
      const ruleHash = await writeContract(walletClient, {
        address: govExit,
        abi: govExitAbi,
        functionName: "setRule",
        args: [parsed.bps],
      });
      await waitForTransactionReceipt(publicClient, { hash: ruleHash });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Transaction failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleOpenPosition(event: FormEvent) {
    event.preventDefault();
    if (!writeReady || !walletClient || !publicClient || !pool) {
      setError("Connect your wallet to Avalanche Fuji to open a position.");
      return;
    }
    const collateralWei = parseTokenAmount(openCollateral);
    const borrowWei = parseTokenAmount(openBorrow);
    if (collateralWei === null || borrowWei === null) {
      setError("Enter amounts as plain decimals, e.g. 10 or 0.5.");
      return;
    }
    if (avaxPriceUsd === undefined || thresholdBps === undefined) {
      setError("Still reading the pool's price and safety limit.");
      return;
    }
    const valid = validateOpenPosition({
      collateralWei,
      borrowAmountWei: borrowWei,
      avaxPriceUsd,
      liquidationThresholdBps: thresholdBps,
    });
    if (!valid.ok) {
      setError(valid.error);
      return;
    }
    setError(null);
    try {
      setBusy("Opening your position…");
      const hash = await writeContract(walletClient, {
        address: pool,
        abi: mockLendingPoolAbi,
        functionName: "openPosition",
        args: [borrowWei],
        value: collateralWei,
      });
      await waitForTransactionReceipt(publicClient, { hash });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Transaction failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!pool || !govExit) {
    return (
      <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
        <p className="text-sm text-amber-300">
          Contract addresses are not configured. Set the <code>NEXT_PUBLIC_*</code>{" "}
          addresses in <code>.env</code>.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <StepCard
        step={1}
        title="Borrow against your AVAX"
        subtitle="Deposit AVAX as security (your collateral), then borrow mUSDC against it. The pool caps your debt at a share of your collateral's value."
      >
        <form className="flex flex-col gap-3" onSubmit={handleOpenPosition}>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-400">Collateral (AVAX)</span>
              <input
                aria-label="Collateral AVAX"
                className="w-32 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                inputMode="decimal"
                placeholder="0.02"
                value={openCollateral}
                onChange={(event) => setOpenCollateral(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-400">Borrow (mUSDC)</span>
              <input
                aria-label="Borrow mUSDC"
                className="w-32 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                inputMode="decimal"
                placeholder="0.26"
                value={openBorrow}
                onChange={(event) => setOpenBorrow(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60"
              disabled={busy !== null || !address}
            >
              {busy === "Opening your position…" ? busy : "Open position"}
            </button>
          </div>

          {thresholdBps !== undefined && (
            <p className="text-xs leading-relaxed text-slate-500">
              Safety limit: <span className="text-slate-300">{bpsToCopy(thresholdBps)}</span> of
              your collateral&apos;s value
              {borrowLimit !== undefined && (
                <>
                  {" "}
                  — with {openCollateral} AVAX you can borrow up to{" "}
                  <span className="text-slate-300">{formatDecimal(borrowLimit, 18)} mUSDC</span>
                </>
              )}
              .
            </p>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>

        {address && active && (
          <dl className="mt-4 flex flex-col gap-2 border-t border-slate-800 pt-4">
            <Row
              label="Collateral"
              value={positionQuery.isLoading ? "…" : `${formatDecimal(collateral, 18)} AVAX`}
            />
            <Row
              label="Collateral value"
              value={usdValue === undefined ? "…" : `$${formatDecimal(usdValue, 18)}`}
            />
            <Row
              label="Debt"
              value={positionQuery.isLoading ? "…" : `${formatDecimal(debt, 18)} mUSDC`}
            />
            <Row
              label="Safety limit"
              value={thresholdBps === undefined ? "…" : bpsToCopy(thresholdBps)}
            />
            <div className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-slate-400">Status</dt>
              <dd>
                {status === undefined ? (
                  <span className="font-mono text-slate-500">…</span>
                ) : (
                  <span
                    className={
                      status === "SAFE"
                        ? "rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300"
                        : "rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-300"
                    }
                  >
                    {status === "SAFE" ? "SAFE" : "AT RISK"}
                  </span>
                )}
              </dd>
            </div>
          </dl>
        )}
        {address && !active && (
          <p className="mt-4 border-t border-slate-800 pt-4 text-sm text-slate-500">
            No active position yet — open one above and it will appear here.
          </p>
        )}
        {!address && (
          <p className="mt-4 text-sm text-slate-500">
            Connect your wallet to open a position.
          </p>
        )}
      </StepCard>

      <StepCard
        step={2}
        title="Set your protection rule"
        subtitle="If governance proposes a safety limit below your number, GovExit closes your position for you — automatically, before the change takes effect."
      >
        <form className="flex flex-col gap-3" onSubmit={handleSetRule}>
          <label className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
            <span>Exit me if the safety limit drops below</span>
            <span className="flex items-center gap-2">
              <input
                aria-label="Minimum threshold percent"
                className="w-24 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                inputMode="decimal"
                placeholder={ruleMinimumBps === undefined ? "70" : formatDecimal(ruleMinimumBps, 2)}
                value={percent}
                onChange={(event) => setPercent(event.target.value)}
              />
              <span className="text-slate-400">%</span>
            </span>
          </label>

          <button
            type="submit"
            className="w-fit rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60"
            disabled={busy !== null || !address}
          >
            {busy ?? (approved ? "Set protection rule" : "Approve GovExit & set rule")}
          </button>

          <p className="text-xs leading-relaxed text-slate-500">
            Approving lets GovExit close your position for you. It can do nothing else.
          </p>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>

        {address && (
          <div className="mt-4 border-t border-slate-800 pt-4">
            {protectionActive ? (
              <p className="text-sm font-medium text-emerald-300">
                🛡 Protection active — exit if the safety limit drops below{" "}
                {ruleMinimumBps === undefined ? "…" : bpsToCopy(ruleMinimumBps)}.
              </p>
            ) : ruleTriggered ? (
              <p className="text-sm text-amber-300">
                Your rule triggered and the position was already closed by an automatic exit.
              </p>
            ) : (
              <p className="text-sm text-slate-500">No protection set yet.</p>
            )}

            {approvalRevoked && (
              <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                ⚠ Your exit agent approval was revoked. The rule cannot fire until you approve
                GovExit again — setting the rule above re-approves it.
              </p>
            )}
          </div>
        )}
      </StepCard>
    </div>
  );
}
