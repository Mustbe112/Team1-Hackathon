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
            Automatic exit protection for your position on Avalanche Fuji.
          </p>
        </div>
        <ConnectWallet />
      </header>

      <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-4">
        <p className="text-sm text-slate-300">
          The demo story: deposit AVAX → borrow mUSDC → set a protection rule → governance
          proposes a riskier safety limit → GovExit exits you automatically.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          <span className="text-slate-400">Collateral</span> = the AVAX you deposit as security ·{" "}
          <span className="text-slate-400">Safety limit</span> (liquidation threshold) = the most
          you may borrow against it ·{" "}
          <span className="text-slate-400">Waiting period</span> (timelock) = the delay before a
          proposal takes effect.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <PositionPanel />
        <DemoAdminPanel />
        <GovernancePanel />
      </div>

      <footer className="mt-auto border-t border-slate-800 pt-4 text-xs text-slate-500">
        Reads live from the Avalanche Fuji contracts; proposal and exit history are scanned from
        the deployment block by polling.
      </footer>
    </main>
  );
}
