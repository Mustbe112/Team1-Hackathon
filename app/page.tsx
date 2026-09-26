import { ConnectWallet } from "@/components/connect-wallet";
import { DemoAdminPanel } from "@/components/demo-admin-panel";
import { GovernancePanel } from "@/components/governance-panel";
import { PositionPanel } from "@/components/position-panel";

const steps = ["Open a position", "Set your rule", "Queue a proposal", "Watch the exit"];

export default function Home() {
  return (
    <main className="dashboard-shell">
      <a className="skip-link" href="#workspace">Skip to dashboard</a>
      <header className="dashboard-header">
        <a className="brand" href="/" aria-label="GovExit home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 3 20 6v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" stroke="currentColor" strokeWidth="1.6"/><path d="m8 12 3 3 5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </span>
          GovExit
        </a>
        <div className="header-actions">
          <span className="network-badge"><span aria-hidden="true" />Avalanche Fuji · Testnet</span>
          <ConnectWallet />
        </div>
      </header>

      <section className="dashboard-intro" aria-labelledby="dashboard-title">
        <div>
          <p className="eyebrow">Governance risk protection</p>
          <h1 id="dashboard-title">Your position.<br /><span>Your safety limit.</span></h1>
          <p className="intro-copy">Set the risk you’re comfortable with. GovExit automatically closes your position when a governance proposal crosses your limit.</p>
        </div>
        <aside className="workflow-guide" aria-label="How the demo works">
          <p className="guide-title">One position. Four steps.</p>
          <ol>{steps.map((step, index) => <li key={step}><span className="guide-number">0{index + 1}</span><span>{step}</span></li>)}</ol>
          <p className="guide-note">A working demo using AVAX and mock USDC on Avalanche Fuji.</p>
        </aside>
      </section>

      <div className="workspace-heading">
        <h2>Your workspace</h2>
        <span>Follow the steps below</span>
      </div>
      <div id="workspace" className="dashboard-grid" tabIndex={-1}>
        <PositionPanel />
        <DemoAdminPanel />
        <GovernancePanel />
      </div>

      <section className="glossary" aria-label="Key terms">
        <div><h2>Collateral</h2><p>The AVAX you deposit as security for your loan.</p></div>
        <div><h2>Safety limit</h2><p>The maximum share of your collateral’s value you can borrow.</p></div>
        <div><h2>Waiting period</h2><p>The delay before a governance proposal takes effect.</p></div>
      </section>
      <footer className="dashboard-footer">
        <span>GovExit <span aria-hidden="true">/</span> Automatic exit protection</span>
        <p>Contract data and transaction history refresh by polling Avalanche Fuji.</p>
      </footer>
    </main>
  );
}
