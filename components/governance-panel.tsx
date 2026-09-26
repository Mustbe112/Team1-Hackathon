"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { readContract } from "viem/actions";
import { avalancheFuji } from "wagmi/chains";
import { useAccount, usePublicClient } from "wagmi";

import {
  exitTriggeredEvent,
  govExitAbi,
  mockGovernanceAbi,
  mockLendingPoolAbi,
  proposalQueuedEvent,
} from "@/lib/abis";
import { env } from "@/lib/env";
import {
  avaxReturned,
  explorerTxUrl,
  formatCountdown,
  formatThresholdChange,
  pickLatestLog,
  ProposalState,
  proposalStateLabel,
  remainingSeconds,
} from "@/lib/governance";
import { scanLogsIncremental, type ChainLog } from "@/lib/logs";
import { bpsToCopy, formatDecimal } from "@/lib/position";

/** Poll interval for every chain read; `eth_newFilter` is unavailable on Fuji. */
const POLL_MS = 5000;

const EXPLORER_BASE =
  avalancheFuji.blockExplorers?.default?.url ?? "https://testnet.snowtrace.io";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-mono text-slate-200">{value}</dd>
    </div>
  );
}

function argBigInt(log: ChainLog | null | undefined, name: string): bigint | undefined {
  const value = log?.args[name];
  return typeof value === "bigint" ? value : undefined;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/**
 * Governance panel (issue 14): the queued Proposal (current → proposed
 * Liquidation threshold), a live countdown anchored on on-chain `executeAfter`,
 * a banner when a Protected user's Exit rule is Triggered or `shouldExit`, and
 * the Automatic-exit receipt with the real Fuji transaction.
 *
 * The Proposal and the exit transaction are discovered from logs scoped to
 * `DEPLOY_BLOCK`; everything else is a `readContract` poll. All formatting and
 * derivation (countdown, returned AVAX, log selection) lives in
 * `lib/governance.ts` so it is unit-tested without a chain.
 */
export function GovernancePanel() {
  const pool = env.addresses.lendingPool;
  const governance = env.addresses.governance;
  const govExit = env.addresses.govExit;
  const publicClient = usePublicClient();
  const { address } = useAccount();

  const readReady = Boolean(publicClient && pool && governance && govExit);

  // The queue event carries the snapshot "current → new" values; `getProposal`
  // then gives the authoritative state + executeAfter.
  const proposalLogQuery = useQuery({
    queryKey: ["govexit", "latestProposal", governance],
    enabled: readReady,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<ChainLog | null> => {
      const logs = await scanLogsIncremental({
        key: `proposalQueued:${governance}`,
        publicClient: publicClient!,
        address: governance!,
        event: proposalQueuedEvent,
        fromBlock: env.deployBlock,
      });
      return pickLatestLog(logs);
    },
  });

  const proposalId = argBigInt(proposalLogQuery.data, "proposalId");
  const queuedCurrentBps = argBigInt(proposalLogQuery.data, "currentThreshold");

  const proposalQuery = useQuery({
    queryKey: ["govexit", "proposal", proposalId?.toString() ?? "none"],
    enabled: readReady && proposalId !== undefined,
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: governance!,
        abi: mockGovernanceAbi,
        functionName: "getProposal",
        args: [proposalId!],
      }),
  });

  const thresholdQuery = useQuery({
    queryKey: ["govexit", "liquidationThresholdBps", address],
    enabled: readReady,
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "liquidationThresholdBps",
      }),
  });

  const timelockQuery = useQuery({
    queryKey: ["govexit", "timelockSeconds", governance],
    enabled: readReady,
    queryFn: () =>
      readContract(publicClient!, {
        address: governance!,
        abi: mockGovernanceAbi,
        functionName: "timelockSeconds",
      }),
  });

  // The on-chain clock, captured with the local time it was read at, so the
  // countdown is anchored on chain rather than a wall-clock guess.
  const clockQuery = useQuery({
    queryKey: ["govexit", "blockTimestamp"],
    enabled: readReady,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const block = await publicClient!.getBlock({ blockTag: "latest" });
      return { chainNow: block.timestamp, fetchedAtMs: Date.now() };
    },
  });

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ruleQuery = useQuery({
    queryKey: ["govexit", "rule", address],
    enabled: readReady && Boolean(address),
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: govExit!,
        abi: govExitAbi,
        functionName: "rules",
        args: [address!],
      }),
  });

  const shouldExitQuery = useQuery({
    queryKey: ["govexit", "shouldExit", address, proposalId?.toString() ?? "none"],
    enabled: readReady && Boolean(address) && proposalId !== undefined,
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: govExit!,
        abi: govExitAbi,
        functionName: "shouldExit",
        args: [address!, proposalId!],
      }),
  });

  const priceQuery = useQuery({
    queryKey: ["govexit", "avaxPriceUsd", address],
    enabled: readReady,
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "AVAX_PRICE_USD",
      }),
  });

  const exitLogQuery = useQuery({
    queryKey: ["govexit", "exitTriggered", govExit, address],
    enabled: readReady && Boolean(address),
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<ChainLog | null> => {
      const logs = await scanLogsIncremental({
        key: `exitTriggered:${govExit}:${address!.toLowerCase()}`,
        publicClient: publicClient!,
        address: govExit!,
        event: exitTriggeredEvent,
        args: { user: address! },
        fromBlock: env.deployBlock,
      });
      return pickLatestLog(logs);
    },
  });

  const exitBlock = exitLogQuery.data?.blockNumber;
  // The Position is zeroed by the exit, so re-read it at the block just before
  // the exit transaction to derive how much AVAX actually came back.
  const exitSummaryQuery = useQuery({
    queryKey: ["govexit", "exitSummary", exitLogQuery.data?.transactionHash ?? "none"],
    enabled: readReady && Boolean(address) && typeof exitBlock === "bigint" && exitBlock > 0n,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "positions",
        args: [address!],
        blockNumber: exitBlock! - 1n,
      }),
  });

  const positionQuery = useQuery({
    queryKey: ["govexit", "position", address],
    enabled: readReady && Boolean(address),
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: pool!,
        abi: mockLendingPoolAbi,
        functionName: "positions",
        args: [address!],
      }),
  });

  const proposal = proposalQuery.data;
  const proposedBps = proposal?.newThresholdBps;
  const executeAfter = proposal?.executeAfter;
  const proposalState = proposal?.state;
  const currentBps = queuedCurrentBps ?? thresholdQuery.data;
  const timelockSeconds = timelockQuery.data;

  const ruleTriggered = ruleQuery.data?.[2] === true;
  const shouldExit = shouldExitQuery.data === true;

  const clock = clockQuery.data;
  const remaining =
    executeAfter !== undefined && clock
      ? remainingSeconds(executeAfter, clock.chainNow, nowMs - clock.fetchedAtMs)
      : undefined;
  const countdownCopy =
    proposalState === ProposalState.QUEUED && remaining !== undefined
      ? remaining === 0
        ? "00:00 · executable now"
        : formatCountdown(remaining)
      : proposalState === undefined
        ? "…"
        : proposalStateLabel(proposalState);

  const exit = exitLogQuery.data;
  const preCollateral = exitSummaryQuery.data?.[0];
  const preDebt = exitSummaryQuery.data?.[1];
  const avaxPriceUsd = priceQuery.data;
  const returnedAvax =
    preCollateral !== undefined && preDebt !== undefined && avaxPriceUsd !== undefined
      ? avaxReturned(preCollateral, preDebt, avaxPriceUsd)
      : undefined;
  const currentDebt = positionQuery.data?.[1];

  if (!pool || !governance || !govExit) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          Governance Proposal
        </h2>
        <p className="mt-4 text-sm text-amber-300">
          Contract addresses are not configured. Set the <code>NEXT_PUBLIC_*</code>{" "}
          addresses in <code>.env</code>.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          Governance Proposal
        </h2>

        {proposalLogQuery.isLoading ? (
          <p className="mt-4 text-sm text-slate-500">Reading the latest Proposal…</p>
        ) : proposalId === undefined ? (
          <p className="mt-4 text-sm text-slate-500">
            No Proposal has been queued yet.
            {thresholdQuery.data !== undefined && (
              <> Current Liquidation threshold: {bpsToCopy(thresholdQuery.data)}.</>
            )}
          </p>
        ) : (
          <dl className="mt-4 flex flex-col gap-2">
            <Row
              label="Liquidation threshold"
              value={
                currentBps === undefined || proposedBps === undefined
                  ? "…"
                  : formatThresholdChange(currentBps, proposedBps)
              }
            />
            <Row
              label="Proposal state"
              value={proposalState === undefined ? "…" : proposalStateLabel(proposalState)}
            />
            <Row label="Executes in" value={countdownCopy} />
          </dl>
        )}

        <p className="mt-4 text-xs text-slate-500">
          The Timelock is mock governance timing
          {timelockSeconds !== undefined ? ` (${timelockSeconds.toString()} seconds)` : ""}, not
          Aave&apos;s real 1-day delay.
        </p>

        {shouldExit && (
          <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            ⚠ Your Exit rule is triggered — the proposed Liquidation threshold is below your
            Minimum threshold, and the Exit agent will close your Position before the Timelock
            ends.
          </p>
        )}
        {!shouldExit && ruleTriggered && (
          <p className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            ✓ Your Exit rule is Triggered — an Automatic exit has already closed this Position.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          Automatic Exit
        </h2>

        {!address ? (
          <p className="mt-4 text-sm text-slate-500">
            Connect your wallet to see your exit receipt.
          </p>
        ) : !exit ? (
          <p className="mt-4 text-sm text-slate-500">
            No Automatic exit yet. When the Exit rule trips, the Keeper calls the Exit agent,
            GovExit closes the Position, and the transaction appears here.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-sm font-medium text-emerald-300">✓ Automatic exit executed</p>
            <dl className="flex flex-col gap-2">
              <Row
                label="Debt repaid"
                value={
                  preDebt === undefined ? "…" : `${formatDecimal(preDebt, 18)} mUSDC`
                }
              />
              <Row label="Debt remaining" value={`$${formatDecimal(currentDebt ?? 0n, 18)}`} />
              <Row
                label="AVAX returned"
                value={
                  returnedAvax === undefined ? "…" : `${formatDecimal(returnedAvax, 18)} AVAX`
                }
              />
              <div className="flex items-center justify-between gap-4 text-sm">
                <dt className="text-slate-400">Exit transaction</dt>
                <dd className="font-mono">
                  {exit.transactionHash ? (
                    <a
                      className="text-sky-400 underline-offset-2 hover:underline"
                      href={explorerTxUrl(EXPLORER_BASE, exit.transactionHash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortHash(exit.transactionHash)}
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </section>
    </div>
  );
}
