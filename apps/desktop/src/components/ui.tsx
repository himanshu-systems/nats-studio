import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ConnectionStatus } from "@bindings";
import { Icon } from "./Icon";

/** Join class names, dropping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-content hover:bg-accent-hover shadow-sm disabled:opacity-50",
  outline:
    "border border-border bg-surface text-content hover:bg-surface-2 disabled:opacity-50",
  ghost: "text-content hover:bg-surface-2 disabled:opacity-40",
  danger:
    "border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-50",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: string;
}): JSX.Element {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 16} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  size = 18,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; size?: number }): JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cx("rounded-xl border border-border bg-surface shadow-panel", className)}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</span>
  );
}

type Tone = "neutral" | "accent" | "positive" | "warning" | "danger";
const TONES: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-muted",
  accent: "border-accent/25 bg-accent/10 text-accent",
  positive: "border-positive/25 bg-positive/10 text-positive",
  warning: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-danger/25 bg-danger/10 text-danger",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

const STATUS_STYLE: Record<ConnectionStatus, { dot: string; label: string; tone: Tone }> = {
  [ConnectionStatus.Connected]: { dot: "bg-positive", label: "Connected", tone: "positive" },
  [ConnectionStatus.Connecting]: { dot: "bg-warning animate-pulse", label: "Connecting", tone: "warning" },
  [ConnectionStatus.Reconnecting]: { dot: "bg-warning animate-pulse", label: "Reconnecting", tone: "warning" },
  [ConnectionStatus.Failed]: { dot: "bg-danger", label: "Failed", tone: "danger" },
  [ConnectionStatus.Disconnected]: { dot: "bg-faint", label: "Disconnected", tone: "neutral" },
};

export function StatusDot({ status }: { status: ConnectionStatus }): JSX.Element {
  return <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", STATUS_STYLE[status].dot)} />;
}

export function statusMeta(status: ConnectionStatus): { label: string; tone: Tone } {
  return { label: STATUS_STYLE[status].label, tone: STATUS_STYLE[status].tone };
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
        <Icon name="search" size={15} />
      </span>
      <input
        className="field pl-8"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-content"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-2 text-muted">
        <Icon name={icon} size={26} />
      </div>
      <h3 className="text-sm font-semibold text-content">{title}</h3>
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}
