import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * An (i) info icon that reveals help text on hover or click (click pins it open,
 * for touch / keeping it visible). Themed popover.
 */
export function InfoTip({ text, className }: { text: ReactNode; className?: string }): JSX.Element {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const open = pinned || hover;

  return (
    <span className={`relative inline-flex ${className ?? ""}`}>
      <button
        type="button"
        aria-label="More info"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={(e) => {
          e.preventDefault();
          setPinned((p) => !p);
        }}
        onBlur={() => setPinned(false)}
        className="text-faint transition-colors hover:text-accent"
      >
        <Icon name="info" size={13} />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 top-[calc(100%+4px)] z-50 w-56 -translate-x-1/2 rounded-lg border border-border bg-overlay p-2 text-[11px] font-normal normal-case leading-snug text-content shadow-pop"
        >
          {text}
        </span>
      )}
    </span>
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
