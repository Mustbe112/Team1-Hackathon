"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

import { explorerTxUrl } from "@/lib/governance";
import { formatDecimal } from "@/lib/position";

export type ExitCelebrationReceipt = {
  /** Debt settled by the exit; undefined while the pre-exit read is in flight. */
  debtRepaidWei?: bigint;
  /** Collateral left after settlement, returned to the wallet. */
  avaxReturnedWei?: bigint;
  /** The exit transaction; null while unknown. */
  transactionHash: `0x${string}` | null;
  /** Fuji explorer base, e.g. `https://testnet.snowtrace.io`. */
  explorerBase: string;
};

/**
 * The payoff moment: a modal that demands attention when the Keeper closes the
 * position during the waiting period — with no user signature.
 *
 * Purely presentational. The live-only trigger lives in `isNewExit` and the
 * panel's watch effect; this dialog only renders what it is given. Values may
 * still be loading (they show `…` and fill in on the next poll). Keyboard:
 * Escape, overlay click, and the acknowledge button all close; Tab wraps
 * inside the dialog; focus is restored to what was focused before opening.
 */
export function ExitCelebrationModal({
  open,
  onClose,
  receipt,
}: {
  open: boolean;
  onClose: () => void;
  receipt: ExitCelebrationReceipt;
}) {
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
    <div className="exit-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="exit-celebration-title"
        className="exit-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <p className="exit-mark" aria-hidden="true">✓</p>
        <h2 id="exit-celebration-title" className="exit-title">
          Your position closed itself.
        </h2>
        <p className="exit-copy">
          GovExit saw the proposal cross your rule and closed the position during the
          waiting period. You didn&apos;t sign anything.
        </p>
        <dl className="exit-rows">
          <div>
            <dt>Debt repaid</dt>
            <dd>
              {receipt.debtRepaidWei === undefined
                ? "…"
                : `${formatDecimal(receipt.debtRepaidWei, 18)} mUSDC`}
            </dd>
          </div>
          <div>
            <dt>AVAX returned</dt>
            <dd>
              {receipt.avaxReturnedWei === undefined
                ? "…"
                : `${formatDecimal(receipt.avaxReturnedWei, 18)} AVAX`}
            </dd>
          </div>
        </dl>
        {receipt.transactionHash && (
          <a
            className="exit-link"
            href={explorerTxUrl(receipt.explorerBase, receipt.transactionHash)}
            target="_blank"
            rel="noreferrer"
          >
            View the exit transaction ↗
          </a>
        )}
        <button ref={acknowledgeRef} type="button" onClick={onClose} className="exit-acknowledge">
          Got it
        </button>
      </div>
    </div>
  );
}
