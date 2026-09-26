import type { ReactNode } from "react";

type Tone = "default" | "admin";

const TONE: Record<
  Tone,
  { section: string; badge: string; title: string; subtitle: string }
> = {
  default: {
    section: "rounded-xl border border-slate-800 bg-slate-900/40 p-5",
    badge: "bg-sky-500/15 text-sky-300",
    title: "text-slate-100",
    subtitle: "text-slate-400",
  },
  admin: {
    section: "rounded-xl border-2 border-dashed border-amber-500/50 bg-amber-500/5 p-5",
    badge: "bg-amber-500/20 text-amber-200",
    title: "text-amber-100",
    subtitle: "text-amber-200/80",
  },
};

/**
 * One numbered step of the demo story.
 *
 * The dashboard is a narrative — borrow, protect, propose, watch — so every
 * panel is a step with a plain-language title and a one-line explanation of what
 * it does and why. Technical names stay in parentheses rather than as headings.
 */
export function StepCard({
  step,
  title,
  subtitle,
  tone = "default",
  children,
}: {
  step: number;
  title: string;
  subtitle?: string;
  tone?: Tone;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <section className={t.section}>
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${t.badge}`}
          aria-hidden
        >
          {step}
        </span>
        <div>
          <h2 className={`text-sm font-semibold ${t.title}`}>{title}</h2>
          {subtitle && (
            <p className={`mt-1 text-xs leading-relaxed ${t.subtitle}`}>{subtitle}</p>
          )}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
