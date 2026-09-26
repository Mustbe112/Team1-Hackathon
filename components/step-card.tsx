import type { ReactNode } from "react";

export function StepCard({ step, title, subtitle, tone = "default", children }: {
  step: number;
  title: string;
  subtitle?: string;
  tone?: "default" | "admin";
  children: ReactNode;
}) {
  return (
    <section className={`step-card${tone === "admin" ? " step-card-admin" : ""}`} aria-labelledby={`step-${step}-title`}>
      <div className="step-heading">
        <span className="step-number" aria-hidden="true">0{step}</span>
        <div>
          <p className="step-kicker">{tone === "admin" ? "Demo governance" : step === 4 ? "Monitor & verify" : "Position setup"}</p>
          <h2 id={`step-${step}-title`}>{title}</h2>
        </div>
      </div>
      {subtitle && <p className="step-subtitle">{subtitle}</p>}
      <div className="step-content">{children}</div>
    </section>
  );
}
