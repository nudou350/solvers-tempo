"use client";
// Full-screen image viewer. Uses <dialog>.showModal(): the browser layer handles the focus trap, Esc and making the
// rest of the page inert; this adds the arrows, the outside click, the counter and returning focus.
import type { ImageRef } from "@solvers/api-client";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export function Lightbox({
  images,
  index,
  onClose,
  label,
}: {
  images: ImageRef[];
  index: number;
  onClose: () => void;
  /** Group name, read by screen readers ("Solver screenshots"). */
  label?: string;
}) {
  const t = useTranslations("common.ui");
  const groupLabel = label ?? t("images");
  const ref = useRef<HTMLDialogElement>(null);
  const [i, setI] = useState(() => Math.min(Math.max(index, 0), Math.max(images.length - 1, 0)));
  const prevFocus = useRef<HTMLElement | null | undefined>(undefined);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const n = images.length;
  const go = (d: number) => setI((cur) => (cur + d + n) % n);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    // Stored once: in StrictMode the effect runs twice and, on the second run, focus is already inside the dialog.
    if (prevFocus.current === undefined) prevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prev = prevFocus.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onNativeClose = () => closeRef.current();
    dlg.addEventListener("close", onNativeClose);
    if (!dlg.open) dlg.showModal();
    return () => {
      dlg.removeEventListener("close", onNativeClose);
      // No dlg.close() here: the <dialog> leaves the DOM with the component. Closing here fires an async "close" event
      // that, in StrictMode (effect running twice), would reach the new listener and close the viewer.
      document.body.style.overflow = overflow;
      prev?.focus();
    };
  }, []);

  const cur = images[i];
  if (!cur) return null;

  return (
    <dialog
      ref={ref}
      className="lightbox"
      aria-label={groupLabel}
      onKeyDown={(e) => {
        if (n < 2) return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          go(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          go(1);
        }
      }}
    >
      <div className="lightbox-bar">
        <button type="button" className="lightbox-btn" onClick={() => closeRef.current()} aria-label={t("close")}>
          <Icon name="x" />
        </button>
        <span className="lightbox-count" aria-live="polite">
          {t("imageCount", { i: i + 1, n })}
        </span>
      </div>
      <div
        className="lightbox-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeRef.current();
        }}
      >
        {n > 1 ? (
          <button type="button" className="lightbox-btn lightbox-nav" onClick={() => go(-1)} aria-label={t("previousImage")}>
            <Icon name="arrow-left" />
          </button>
        ) : null}
        <img key={cur.id} src={cur.url} width={cur.width} height={cur.height} alt={t("imageAlt", { label: groupLabel, i: i + 1, n })} decoding="async" />
        {n > 1 ? (
          <button type="button" className="lightbox-btn lightbox-nav" onClick={() => go(1)} aria-label={t("nextImage")}>
            <Icon name="arrow-right" />
          </button>
        ) : null}
      </div>
    </dialog>
  );
}
