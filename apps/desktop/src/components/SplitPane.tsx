import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./ui";

/** Clamp a percentage into the pane's allowed range. */
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

const storageKey = (id: string): string => `ns.split.${id}`;

/** Read a persisted split, ignoring anything unusable (private mode, bad data). */
function loadSize(id: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function saveSize(id: string, pct: number): void {
  try {
    localStorage.setItem(storageKey(id), String(Math.round(pct * 100) / 100));
  } catch {
    /* storage unavailable — the split still works, it just won't persist */
  }
}

/** `true` while the viewport is at least `px` wide. */
export function useMinWidth(px: number): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(`(min-width: ${px}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [px]);
  return matches;
}

export interface SplitPaneProps {
  /** Stable id — the split position is remembered per id. */
  id: string;
  /** `horizontal` splits left/right, `vertical` splits top/bottom. */
  orientation?: "horizontal" | "vertical";
  /** Starting size of the first pane, as a percentage. */
  initial?: number;
  /** Bounds for the first pane, as percentages. */
  min?: number;
  max?: number;
  /**
   * Below this viewport width the panes stack and the divider is hidden —
   * mirrors the `lg:` breakpoints the views used before they were split.
   */
  stackBelow?: number;
  className?: string;
  /** Exactly two children: the two panes. */
  children: [ReactNode, ReactNode];
}

/**
 * Two panes with a divider you can drag, double-click to reset, or nudge with
 * the arrow keys when it has focus. The position persists per `id`.
 *
 * Implemented as a CSS grid whose template is driven by one percentage, so a
 * drag only rewrites that value — the panes themselves never re-render from
 * layout, and each pane keeps `min-*-0` so its own scrolling still works.
 */
export function SplitPane({
  id,
  orientation = "horizontal",
  initial = 50,
  min = 15,
  max = 85,
  stackBelow,
  className,
  children,
}: SplitPaneProps): JSX.Element {
  const horizontal = orientation === "horizontal";
  const [pct, setPct] = useState(() => clamp(loadSize(id, initial), min, max));
  const [dragging, setDragging] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const wideEnough = useMinWidth(stackBelow ?? 0);
  const split = stackBelow === undefined || wideEnough;

  const apply = useCallback(
    (next: number) => {
      const v = clamp(next, min, max);
      setPct(v);
      saveSize(id, v);
    },
    [id, min, max],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    // Capture keeps the drag alive when the pointer outruns the 1px divider.
    // It's an optimisation, not a requirement — not every engine implements it.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = horizontal
      ? ((e.clientX - rect.left) / rect.width) * 100
      : ((e.clientY - rect.top) / rect.height) * 100;
    apply(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 10 : 2;
    const back = horizontal ? "ArrowLeft" : "ArrowUp";
    const fwd = horizontal ? "ArrowRight" : "ArrowDown";
    if (e.key === back) apply(pct - step);
    else if (e.key === fwd) apply(pct + step);
    else if (e.key === "Home") apply(min);
    else if (e.key === "End") apply(max);
    else if (e.key === "Enter") apply(initial);
    else return;
    e.preventDefault();
  };

  // While dragging, keep the resize cursor and stop the drag selecting text.
  useEffect(() => {
    if (!dragging) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, horizontal]);

  if (!split) {
    return (
      <div className={cx("flex min-h-0 flex-col", className)}>
        {children[0]}
        {children[1]}
      </div>
    );
  }

  const template = `${pct}fr 1px ${100 - pct}fr`;

  return (
    <div
      ref={wrapRef}
      className={cx("grid min-h-0 min-w-0", className)}
      style={horizontal ? { gridTemplateColumns: template } : { gridTemplateRows: template }}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{children[0]}</div>

      <div
        role="separator"
        tabIndex={0}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label="Resize panes"
        title="Drag to resize · double-click to reset · arrow keys to nudge"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => apply(initial)}
        onKeyDown={onKeyDown}
        className={cx(
          "relative bg-border transition-colors focus:outline-none",
          horizontal ? "cursor-col-resize" : "cursor-row-resize",
          dragging ? "bg-accent" : "hover:bg-accent/60 focus-visible:bg-accent",
        )}
      >
        {/* the visible line is 1px; this widens the grab target either side */}
        <span
          aria-hidden
          className={cx("absolute", horizontal ? "-inset-x-1 inset-y-0" : "-inset-y-1 inset-x-0")}
        />
      </div>

      <div className="min-h-0 min-w-0 overflow-hidden">{children[1]}</div>
    </div>
  );
}
