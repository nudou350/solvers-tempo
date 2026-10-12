"use client";
// Modal window over the native <dialog>: showModal() handles the focus trap, Esc and making the page inert.
// Mounting the component opens the window; `onClose` asks the parent to unmount it (Esc, outside click, X button).
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

export type DialogProps = {
  /** Window title (becomes its accessible name). */
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** While true (e.g. signing a transaction), Esc, outside click and the X button do not close it. */
  locked?: boolean;
  /** Max width in px (default 480). */
  width?: number;
};

/**
 * To put the initial focus on a field (and not on the close button), mark it with `data-autofocus`.
 * On close, focus returns to the element that opened the window and page scrolling is released.
 */
export function Dialog({ title, onClose, children, locked = false, width }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const titleId = useId();
  const t = useTranslations("common.ui");

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The "close" from the effect cleanup arrives after the effect ran again (StrictMode): with the dialog open, it is a stale echo.
    // Locked (signing): Chrome closes on the 2nd Esc even with preventDefault on "cancel"; reopen so the window does not vanish.
    // showModal() does not fire "close", so there is no loop; the effect cleanup removes this listener before closing on purpose.
    const onNativeClose = () => {
      if (dlg.open) return;
      if (lockedRef.current && dlg.isConnected) dlg.showModal();
      else closeRef.current();
    };
    // Esc: with the window locked, the browser does not close it.
    const onCancel = (e: Event) => {
      if (lockedRef.current) e.preventDefault();
    };
    dlg.addEventListener("close", onNativeClose);
    dlg.addEventListener("cancel", onCancel);
    if (!dlg.open) {
      dlg.showModal();
      dlg.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    return () => {
      dlg.removeEventListener("close", onNativeClose);
      dlg.removeEventListener("cancel", onCancel);
      if (dlg.open) dlg.close();
      document.body.style.overflow = overflow;
      prev?.focus();
    };
  }, []);

  const requestClose = () => {
    if (!lockedRef.current) closeRef.current();
  };

  return (
    <dialog
      ref={ref}
      className="dlg"
      style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === ref.current) requestClose();
      }}
    >
      <div className="dlg-body">
        <div className="row between start" style={{ gap: 12 }}>
          <h2 id={titleId} className="h3" style={{ margin: 0 }}>
            {title}
          </h2>
          <button type="button" className="dlg-x" onClick={requestClose} aria-label={t("close")} disabled={locked}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
