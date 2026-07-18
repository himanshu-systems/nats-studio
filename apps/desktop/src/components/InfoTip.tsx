import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

const TIP_WIDTH = 240;

/**
 * An (i) info icon that reveals help text on hover, or click to pin it open.
 * The tooltip is rendered in a portal with fixed, viewport-clamped positioning
 * so it never gets clipped by scroll containers or overlaps adjacent fields.
 */
export function InfoTip({ text }: { text: ReactNode }): JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = pinned || hover;

  const place = (): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - TIP_WIDTH / 2, window.innerWidth - TIP_WIDTH - 8));
    setPos({ top: r.bottom + 6, left });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="More info"
        onMouseEnter={() => {
          place();
          setHover(true);
        }}
        onMouseLeave={() => setHover(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          place();
          setPinned((p) => !p);
        }}
        onBlur={() => setPinned(false)}
        className="text-faint transition-colors hover:text-accent"
      >
        <Icon name="info" size={13} />
      </button>
      {open &&
        pos &&
        createPortal(
          <span
            role="tooltip"
            style={{ position: "fixed", top: pos.top, left: pos.left, width: TIP_WIDTH }}
            className="z-[100] rounded-lg border border-border bg-overlay p-2 text-[11px] font-normal normal-case leading-snug text-content shadow-pop"
          >
            {text}
          </span>,
          document.body,
        )}
    </>
  );
}

/** A field label with a trailing (i) tooltip explaining the option. */
export function TipLabel({ children, tip }: { children: ReactNode; tip: ReactNode }): JSX.Element {
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted">
      {children}
      <InfoTip text={tip} />
    </span>
  );
}
