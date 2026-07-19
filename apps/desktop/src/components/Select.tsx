import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { cx } from "./ui";

interface PopoverPos {
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

export interface Option {
  value: string;
  label: string;
  /** Optional secondary text shown muted next to the label. */
  hint?: string;
}

/**
 * Searchable dropdown (combobox): a styled trigger that opens a popover with a
 * search box and a filtered, scrollable option list. Drop-in replacement for a
 * native <select> — controlled via `value`/`onChange`.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  className,
  searchable = true,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  searchable?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  // Fixed, viewport-clamped position so the popover (rendered in a portal) is
  // never clipped by a scroll/overflow ancestor. Flips above the trigger when
  // there isn't room below. Mirrors the pattern in InfoTip.
  const place = (): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const maxW = Math.min(448, window.innerWidth * 0.8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - Math.min(maxW, Math.max(r.width, 160)) - 8));
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const spaceAbove = r.top - 8;
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    setPos({
      left,
      minWidth: r.width,
      maxWidth: Math.min(maxW, window.innerWidth - left - 8),
      maxHeight: Math.max(160, (openUp ? spaceAbove : spaceBelow) - 4),
      top: openUp ? undefined : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const reposition = (): void => place();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle === ""
        ? options
        : options.filter(
            (o) =>
              o.label.toLowerCase().includes(needle) ||
              o.value.toLowerCase().includes(needle) ||
              (o.hint ?? "").toLowerCase().includes(needle),
          ),
    [options, needle],
  );

  useLayoutEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
    }
  }, [open]);
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  const commit = (v: string): void => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[active];
      if (opt) commit(opt.value);
    }
  };

  return (
    <div className={cx("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-content outline-none transition-colors hover:bg-surface-2 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-accent ring-2 ring-accent/25",
        )}
      >
        <span className={cx("truncate", !selected && "text-faint")}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron-down" size={15} className={cx("shrink-0 text-faint transition-transform", open && "rotate-180")} />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <button type="button" aria-label="Close" className="fixed inset-0 z-[80] cursor-default" onClick={() => setOpen(false)} />
            <div
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                bottom: pos.bottom,
                minWidth: pos.minWidth,
                maxWidth: pos.maxWidth,
                maxHeight: pos.maxHeight,
              }}
              className="z-[81] flex w-max animate-fade-in flex-col overflow-hidden rounded-xl border border-border bg-overlay shadow-pop"
              onKeyDown={onKeyDown}
            >
            {searchable && (
              <div className="shrink-0 border-b border-border p-1.5">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint">
                    <Icon name="search" size={14} />
                  </span>
                  <input
                    ref={searchRef}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search…"
                    spellCheck={false}
                    className="w-full rounded-md bg-surface-2 py-1.5 pl-7 pr-2 text-sm text-content outline-none placeholder:text-faint"
                  />
                </div>
              </div>
            )}
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-2.5 py-3 text-center text-xs text-muted">No matches</div>
              ) : (
                filtered.map((o, i) => (
                  <button
                    key={o.value}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(o.value)}
                    className={cx(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                      i === active ? "bg-surface-2" : "",
                      o.value === value ? "text-accent" : "text-content",
                    )}
                  >
                    <span className="min-w-0 flex-1 break-words">
                      {o.label}
                      {o.hint && <span className="ml-2 text-xs text-muted">{o.hint}</span>}
                    </span>
                    {o.value === value && <Icon name="check" size={15} className="shrink-0 text-accent" />}
                  </button>
                ))
              )}
            </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
