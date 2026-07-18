import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { cx } from "./ui";

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
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

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

      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 animate-fade-in overflow-hidden rounded-xl border border-border bg-overlay shadow-pop"
            onKeyDown={onKeyDown}
          >
            {searchable && (
              <div className="border-b border-border p-1.5">
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
            <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
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
                    <span className="min-w-0 flex-1 truncate">
                      {o.label}
                      {o.hint && <span className="ml-2 text-xs text-muted">{o.hint}</span>}
                    </span>
                    {o.value === value && <Icon name="check" size={15} className="shrink-0 text-accent" />}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
