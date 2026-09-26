"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { readContract, waitForTransactionReceipt, writeContract } from "viem/actions";
import { avalancheFuji } from "wagmi/chains";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { StepCard } from "@/components/step-card";
import { mockGovernanceAbi, mockLendingPoolAbi } from "@/lib/abis";
import {
  DEFAULT_PROPOSAL_PERCENT,
  DEFAULT_TIMELOCK_INPUT,
  NOT_DEMO_ADMIN_ERROR,
  demoAdminTxError,
  isDemoAdmin,
  parseTimelockSeconds,
} from "@/lib/demo-admin";
import { env } from "@/lib/env";
import { bpsToCopy, parsePercentToBps } from "@/lib/position";

/** Poll interval for every chain read; `eth_newFilter` is unavailable on Fuji. */
const POLL_MS = 5000;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-mono text-slate-200">{value}</dd>
    </div>
  );
}

/**
 * Step 3 — the trusted Demo Admin (issue 15).
 *
 * A deliberately separate, visually distinct section for the single address
 * that owns `MockGovernance`. It shows the current Liquidation threshold and
 * lets the connected Core wallet queue a Proposal (`queueThresholdChange`) and
 * set the Timelock (`setTimelock`). Ownership is read from `owner()` and
 * compared to the connected address; a non-owner sees a clear error rather than
 * a raw revert. No private key is ever in the browser.
 */
export function DemoAdminPanel() {
  const pool = env.addresses.lendingPool;
  const governance = env.addresses.governance;
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { address, chain } = useAccount();
  const queryClient = useQueryClient();

  const readReady = Boolean(publicClient && pool && governance);
  const onFuji = chain?.id === avalancheFuji.id;
  const writeReady = Boolean(walletClient && address && governance && onFuji);

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

  const ownerQuery = useQuery({
    queryKey: ["govexit", "governanceOwner", governance],
    enabled: readReady,
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: governance!,
        abi: mockGovernanceAbi,
        functionName: "owner",
      }),
  });

  const timelockQuery = useQuery({
    queryKey: ["govexit", "timelockSeconds", governance],
    enabled: readReady,
    refetchInterval: POLL_MS,
    queryFn: () =>
      readContract(publicClient!, {
        address: governance!,
        abi: mockGovernanceAbi,
        functionName: "timelockSeconds",
      }),
  });

  const [proposalPercent, setProposalPercent] = useState(DEFAULT_PROPOSAL_PERCENT);
  const [timelockInput, setTimelockInput] = useState(DEFAULT_TIMELOCK_INPUT);
  const [busy, setBusy] = useState<"queue" | "timelock" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const owner = ownerQuery.data;
  const isOwner = isDemoAdmin(owner, address);
  const notOwner = Boolean(address) && owner !== undefined && !isOwner;
  const thresholdBps = thresholdQuery.data;
  const timelockSeconds = timelockQuery.data;

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ["govexit"] });
  }

  async function handleQueue(event: FormEvent) {
    event.preventDefault();
    const parsed = parsePercentToBps(proposalPercent);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!writeReady || !walletClient || !publicClient || !governance) {
      setError("Connect your wallet to Avalanche Fuji to queue a proposal.");
      return;
    }
    if (!isOwner) {
      setError(NOT_DEMO_ADMIN_ERROR);
      return;
    }
    setError(null);
    try {
      setBusy("queue");
      const hash = await writeContract(walletClient, {
        address: governance,
        abi: mockGovernanceAbi,
        functionName: "queueThresholdChange",
        args: [parsed.bps],
      });
      await waitForTransactionReceipt(publicClient, { hash });
      await refresh();
    } catch {
      // Never surface the raw revert; the Demo Admin gets honest retry copy.
      setError(demoAdminTxError(owner, address));
    } finally {
      setBusy(null);
    }
  }

  async function handleSetTimelock(event: FormEvent) {
    event.preventDefault();
    const parsed = parseTimelockSeconds(timelockInput);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!writeReady || !walletClient || !publicClient || !governance) {
      setError("Connect your wallet to Avalanche Fuji to set the waiting period.");
      return;
    }
    if (!isOwner) {
      setError(NOT_DEMO_ADMIN_ERROR);
      return;
    }
    setError(null);
    try {
      setBusy("timelock");
      const hash = await writeContract(walletClient, {
        address: governance,
        abi: mockGovernanceAbi,
        functionName: "setTimelock",
        args: [parsed.seconds],
      });
      await waitForTransactionReceipt(publicClient, { hash });
      await refresh();
    } catch {
      setError(demoAdminTxError(owner, address));
    } finally {
      setBusy(null);
    }
  }

  if (!pool || !governance) {
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
    <StepCard
      step={3}
      tone="admin"
      title="Propose a safety limit change"
      subtitle="Standing in for a DAO: propose lowering the safety limit. Only the Demo Admin wallet can queue a proposal — it is not a voter, and not the Keeper."
    >
      <span className="rounded-md bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-200">
        Demo admin access
      </span>

      <dl className="mt-4">
        <Row
          label="Current safety limit"
          value={thresholdBps === undefined ? "…" : bpsToCopy(thresholdBps)}
        />
      </dl>

      {!address ? (
        <p className="mt-4 text-sm text-amber-200/80">
          Connect the Demo Admin wallet to queue a proposal or set the waiting period.
        </p>
      ) : notOwner ? (
        <p className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          ⚠ {NOT_DEMO_ADMIN_ERROR}
        </p>
      ) : isOwner ? (
        <p className="mt-4 text-sm font-medium text-emerald-300">
          ✓ Connected as the Demo Admin.
        </p>
      ) : (
        <p className="mt-4 text-sm text-slate-500">Reading the Demo Admin owner…</p>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        Queuing proposes a new limit; it does not change the current one. After the
        waiting period, use Execute proposal in step 4 to apply the change.
      </p>

      <form className="mt-4 flex flex-col gap-4" onSubmit={handleQueue}>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-amber-200/80">New safety limit (%)</span>
            <input
              aria-label="Proposal value percent"
              className="w-28 rounded-md border border-amber-500/40 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-amber-400 focus:outline-none"
              inputMode="decimal"
              value={proposalPercent}
              onChange={(event) => setProposalPercent(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-amber-200/80">
              Waiting period (seconds)
            </span>
            <input
              aria-label="Timelock seconds"
              className="w-28 rounded-md border border-amber-500/40 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-amber-400 focus:outline-none"
              inputMode="numeric"
              value={timelockInput}
              onChange={(event) => setTimelockInput(event.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-50"
            disabled={busy !== null || !writeReady || !isOwner}
          >
            {busy === "queue" ? "Queueing proposal…" : "Queue governance proposal"}
          </button>
          <button
            type="button"
            className="rounded-md border border-amber-500/60 px-4 py-2 text-sm font-medium text-amber-200 hover:border-amber-400 disabled:opacity-50"
            disabled={busy !== null || !writeReady || !isOwner}
            onClick={handleSetTimelock}
          >
            {busy === "timelock" ? "Setting waiting period…" : "Set waiting period"}
          </button>
        </div>

        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      </form>

      <p className="mt-4 border-t border-amber-500/20 pt-4 text-xs leading-relaxed text-amber-200/70">
        This is mock governance timing
        {timelockSeconds !== undefined ? ` (${timelockSeconds.toString()} seconds)` : ""}, not
        Aave&apos;s real 1-day delay. The queued proposal&apos;s countdown appears in step 4.
      </p>
    </StepCard>
  );
}
