"use client";

import {
  useAccount,
  useConnect,
  useConnectors,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { avalancheFuji } from "wagmi/chains";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Wallet surface for the dashboard.
 *
 * Connectors come from `useConnectors()`, which wagmi populates from EIP-6963
 * announcements, so Core and any other installed wallet can be chosen
 * explicitly rather than whoever last claimed `window.ethereum`.
 */
export function ConnectWallet() {
  const { address, isConnected, chain } = useAccount();
  const connectors = useConnectors();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const wrongChain = isConnected && chain?.id !== avalancheFuji.id;

  if (isConnected && address) {
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-slate-800 px-3 py-1.5 font-mono text-sm text-slate-200">
            {shortAddress(address)}
          </span>
          <span
            className={
              wrongChain
                ? "rounded-md bg-amber-500/15 px-3 py-1.5 text-sm text-amber-300"
                : "rounded-md bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-300"
            }
          >
            {chain?.name ?? "Unknown chain"}
          </span>
          <button
            type="button"
            onClick={() => disconnect()}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500 hover:text-slate-100"
          >
            Disconnect
          </button>
        </div>
        {wrongChain && (
          <button
            type="button"
            onClick={() => switchChain({ chainId: avalancheFuji.id })}
            disabled={isSwitching}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-60"
          >
            {isSwitching ? "Switching…" : `Switch to ${avalancheFuji.name}`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {connectors.length === 0 && (
          <span className="text-sm text-slate-500">Install a browser wallet to connect</span>
        )}
        {connectors.map((connector, index) => (
          <button
            key={connector.uid}
            type="button"
            onClick={() => connect({ connector })}
            disabled={isPending}
            className={index === 0 ? "rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60" : "rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:border-slate-400 disabled:opacity-60"}
          >
            {isPending ? "Connecting…" : `Connect ${connector.name}`}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-red-400">{error.message}</p>
      )}
    </div>
  );
}
