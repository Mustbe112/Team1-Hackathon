"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { readContract, waitForTransactionReceipt, writeContract } from "viem/actions";
import { avalancheFuji } from "wagmi/chains";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { CelebrationDialog } from "@/components/celebration-dialog";
import { StepCard } from "@/components/step-card";
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
  canExecuteProposal,
  explorerTxUrl,
  formatThresholdChange,
  initialExitWatch,
  isNewExit,
  pickLatestLog,
  ProposalState,
  proposalStateLabel,
  proposalCountdownCopy,
  runProposalExecution,
  shouldCelebrateExecution,
  type ExitWatch,
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
      <dd className="font-mono text-base font-medium text-slate-100">{value}</dd>
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
  const { address, chain } = useAccount();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const [executing, setExecuting] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionHash, setExecutionHash] = useState<`0x${string}` | null>(null);
  const [celebrationOpen, setCelebrationOpen] = useState(false);
  const [executionCelebrationOpen, setExecutionCelebrationOpen] = useState(false);
  // Live-only exit watch: the receipt hash captured when the exit scan first
  // resolved on this page. A reload never re-triggers the celebration because
  // the baseline is re-captured on mount and nothing is persisted.
  const exitWatchRef = useRef<ExitWatch>(initialExitWatch());

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
  const countdownCopy = proposalCountdownCopy(
    proposalState, executeAfter, clock?.chainNow, clock ? nowMs - clock.fetchedAtMs : 0,
  );

  const executable = canExecuteProposal(proposalState, executeAfter, clock?.chainNow);
  const writeReady = Boolean(walletClient && address && chain?.id === avalancheFuji.id);

  async function handleExecute() {
    if (!executable || !writeReady || !walletClient || !publicClient || !governance || proposalId === undefined || executing) return;
    setExecuting(true);
    setExecutionError(null);
    setExecutionHash(null);
    try {
      const result = await runProposalExecution({
        send: async () => {
          const hash = await writeContract(walletClient, {
            address: governance,
            abi: mockGovernanceAbi,
            functionName: "executeProposal",
            args: [proposalId],
          });
          setExecutionHash(hash);
          return hash;
        },
        wait: (hash) => waitForTransactionReceipt(publicClient, { hash }),
        refresh: () => queryClient.invalidateQueries({ queryKey: ["govexit"] }),
      });
      if (shouldCelebrateExecution(result)) {
        setExecutionCelebrationOpen(true);
      } else if (result.status === "not-submitted") {
        setExecutionError("Could not submit the proposal execution. Check your wallet for a rejection or pending transaction before trying again.");
      } else if (result.status === "reverted") {
        setExecutionError("The execution transaction reverted. Check the current proposal and limit before trying again.");
      } else if (result.status === "unconfirmed") {
        setExecutionError("Transaction submitted, but confirmation is unavailable. It may still execute or may already have executed. Check the transaction and current proposal before trying again.");
      }
    } finally {
      setExecuting(false);
    }
  }

  const exit = exitLogQuery.data;
  const preCollateral = exitSummaryQuery.data?.[0];
  const preDebt = exitSummaryQuery.data?.[1];
  const avaxPriceUsd = priceQuery.data;
  const returnedAvax =
    preCollateral !== undefined && preDebt !== undefined && avaxPriceUsd !== undefined
      ? avaxReturned(preCollateral, preDebt, avaxPriceUsd)
      : undefined;
  const currentDebt = positionQuery.data?.[1];
  const latestExitHash = exit?.transactionHash ?? null;

  // Celebrate only when the receipt changes during this session: the first
  // resolved poll seeds the baseline, a changed hash pops the modal, and the
  // baseline moves with it so the same exit never announces itself twice.
  useEffect(() => {
    if (exitLogQuery.isLoading) return;
    const watch = exitWatchRef.current;
    if (!watch.initialized) {
      watch.initialized = true;
      watch.baseline = latestExitHash;
      return;
    }
    if (isNewExit(watch, latestExitHash)) {
      watch.baseline = latestExitHash;
      setCelebrationOpen(true);
    }
  }, [latestExitHash, exitLogQuery.isLoading]);

  if (!pool || !governance || !govExit) {
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
    <>
    <StepCard
      step={4}
      title="Watch the automatic exit"
      subtitle="GovExit can close your position during the waiting period. Once the period ends, execute the proposal to apply the new safety limit."
    >
      <div className="flex flex-col gap-4">
        <h3 className="text-xs font-semibold text-slate-300">Proposal</h3>

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
              label="Proposed change"
              value={
                currentBps === undefined || proposedBps === undefined
                  ? "…"
                  : formatThresholdChange(currentBps, proposedBps)
              }
            />
            <Row
              label="Current safety limit"
              value={thresholdQuery.data === undefined ? "…" : bpsToCopy(thresholdQuery.data)}
            />
            <Row
              label="Proposal status"
              value={proposalState === undefined ? "…" : proposalStateLabel(proposalState)}
            />
            <Row label="Takes effect in" value={countdownCopy} />
          </dl>
        )}

        {proposalState === ProposalState.QUEUED && (
          <div className="rounded-md border border-slate-700 p-4">
            <p className="text-sm text-slate-300">
              {executable
                ? "The waiting period has ended. Execute this proposal to apply the proposed limit to the pool."
                : "The current limit stays unchanged while this proposal is queued. After the waiting period, execute it to apply the new limit."}
            </p>
            <button
              type="button"
              onClick={handleExecute}
              disabled={!executable || !writeReady || executing}
              className="mt-4 rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60"
            >
              {executing ? "Executing proposal…" : "Execute proposal"}
            </button>
            {!writeReady && <p className="mt-2 text-xs text-slate-400">Connect your wallet to Avalanche Fuji to execute.</p>}
          </div>
        )}

        {executionHash && (
          <p className="text-sm text-slate-300">
            Execution transaction:{" "}
            <a className="text-sky-400 underline" href={explorerTxUrl(EXPLORER_BASE, executionHash)} target="_blank" rel="noreferrer">
              {shortHash(executionHash)}
            </a>
          </p>
        )}
        {executionError && <p role="alert" className="text-sm text-red-400">{executionError}</p>}

        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          The waiting period is mock governance timing
          {timelockSeconds !== undefined ? ` (${timelockSeconds.toString()} seconds)` : ""}, not
          Aave&apos;s real 1-day delay.
        </p>

        {shouldExit && (
          <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            ⚠ Your rule is triggered — the proposed safety limit is below your minimum, so
            GovExit will close your position before the waiting period ends.
          </p>
        )}
        {!shouldExit && ruleTriggered && (
          <p className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            ✓ Your rule triggered — an automatic exit has already closed this position.
          </p>
        )}
      <div className="border-t border-slate-800 pt-4">
        <h3 className="text-xs font-semibold text-slate-300">Automatic exit</h3>

        {!address ? (
          <p className="mt-4 text-sm text-slate-500">
            Connect your wallet to see your exit receipt.
          </p>
        ) : !exit ? (
          <p className="mt-4 text-sm text-slate-500">
            No automatic exit yet. When your rule trips, the Keeper calls GovExit, the position
            is closed, and the transaction appears here.
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
              <Row
                label="Debt remaining"
                value={`${formatDecimal(currentDebt ?? 0n, 18)} mUSDC`}
              />
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
      </div>
      </div>
    </StepCard>
    <CelebrationDialog
      open={celebrationOpen}
      onClose={() => setCelebrationOpen(false)}
      title="Your position closed itself."
      copy="GovExit saw the proposal cross your rule and closed the position during the waiting period. You didn't sign anything."
      rows={[
        {
          label: "Debt repaid",
          value: preDebt === undefined ? "…" : `${formatDecimal(preDebt, 18)} mUSDC`,
        },
        {
          label: "AVAX returned",
          value: returnedAvax === undefined ? "…" : `${formatDecimal(returnedAvax, 18)} AVAX`,
        },
      ]}
      transactionHash={latestExitHash}
      explorerBase={EXPLORER_BASE}
      linkLabel="View the exit transaction ↗"
    />
    <CelebrationDialog
      open={executionCelebrationOpen}
      onClose={() => setExecutionCelebrationOpen(false)}
      title="The safety limit changed."
      copy="The proposal executed after its waiting period and the pool now enforces the new safety limit."
      rows={[
        {
          label: "Safety limit",
          value:
            queuedCurrentBps !== undefined && proposedBps !== undefined
              ? formatThresholdChange(queuedCurrentBps, proposedBps)
              : "…",
        },
        {
          label: "Proposal",
          value: proposalId === undefined ? "…" : `#${proposalId}`,
        },
      ]}
      transactionHash={executionHash}
      explorerBase={EXPLORER_BASE}
      linkLabel="View the execution transaction ↗"
    />
    </>
  );
}
