import { ConnectWallet } from "@/components/connect-wallet";
import { DemoAdminPanel } from "@/components/demo-admin-panel";
import { GovernancePanel } from "@/components/governance-panel";
import { PositionPanel } from "@/components/position-panel";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-[0.2em] text-slate-100">GOVEXIT</h1>
          <p className="mt-1 text-sm text-slate-400">
            Automatic exit protection for your Position on Avalanche Fuji.
          </p>
        </div>
        <ConnectWallet />
      </header>

      <div className="flex flex-col gap-4">
        <PositionPanel />
        <GovernancePanel />
        <DemoAdminPanel />
      </div>

      <footer className="mt-auto border-t border-slate-800 pt-4 text-xs text-slate-500">
        Reads live from the Fuji contracts via <code className="text-slate-400">NEXT_PUBLIC_*</code>.
        Proposal and exit history are scanned from the deployment block by polling.
      </footer>
    </main>
  );
}
