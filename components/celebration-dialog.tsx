"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";

import { explorerTxUrl } from "@/lib/governance";

export type CelebrationRow = { label: string; value: string };

/**
 * The canonical celebration dialog — composed twice by the governance panel:
 * the automatic exit (phase A) and the executed proposal (phase B).
 *
 * Purely presentational. Callers decide *when* it opens (`isNewExit`,
 * `shouldCelebrateExecution`) and *what* shows; rows arrive pre-formatted.
 * Keyboard: Escape, overlay click, and the acknowledge button all close; Tab
 * wraps inside the dialog; focus is restored to what was focused before
 * opening. Entrance motion is guarded by `prefers-reduced-motion`.
 */
export function CelebrationDialog({
  open,
  onClose,
  title,
  copy,
  rows = [],
  transactionHash = null,
  explorerBase,
  linkLabel,
  acknowledgeLabel = "Got it",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  copy?: string;
  rows?: CelebrationRow[];
  transactionHash?: `0x${string}` | null;
  explorerBase: string;
  linkLabel?: string;
  acknowledgeLabel?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Focus the acknowledge action on open, freeze background scroll, and
  // restore both on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    acknowledgeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="celebration-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="celebration-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <p className="celebration-mark" aria-hidden="true">✓</p>
        <h2 id={titleId} className="celebration-title">{title}</h2>
        {copy && <p className="celebration-copy">{copy}</p>}
        {rows.length > 0 && (
          <dl className="celebration-rows">
            {rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {transactionHash && linkLabel && (
          <a
            className="celebration-link"
            href={explorerTxUrl(explorerBase, transactionHash)}
            target="_blank"
            rel="noreferrer"
          >
            {linkLabel}
          </a>
        )}
        <button
          ref={acknowledgeRef}
          type="button"
          onClick={onClose}
          className="celebration-acknowledge"
        >
          {acknowledgeLabel}
        </button>
      </div>
    </div>
  );
}
