import type { ReactNode } from "react";

/** Outline icon set (24×24, `currentColor` stroke). Names used across the app. */
const ICONS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  bolt: <path d="M13 3 L4 14 h6 l-1 7 10-11 h-6 z" />,
  activity: <path d="M3 12 h4 l3 8 4-16 3 8 h4" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7 v5 l3 2" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5 v14 c0 1.7 3.6 3 8 3 s8-1.3 8-3 V5" />
      <path d="M4 12 c0 1.7 3.6 3 8 3 s8-1.3 8-3" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 L21 8 L12 13 L3 8 Z" />
      <path d="M3 12 L12 17 L21 12" />
      <path d="M3 16 L12 21 L21 16" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M11 11 L20 20" />
      <path d="M18 18 l2-2" />
      <path d="M15.5 15.5 l2-2" />
    </>
  ),
  cube: (
    <>
      <path d="M12 2 L21 7 V17 L12 22 L3 17 V7 Z" />
      <path d="M3 7 L12 12 L21 7" />
      <path d="M12 12 V22" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8 V19 a1 1 0 0 0 1 1 h12 a1 1 0 0 0 1-1 V8" />
      <path d="M10 12 h4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20 a6 6 0 0 1 12 0" />
      <path d="M16 5 a3.2 3.2 0 0 1 0 6.4" />
      <path d="M15 15.2 a5.6 5.6 0 0 1 3.8 4.8" />
    </>
  ),
  signal: (
    <>
      <path d="M5 12.5 a7 7 0 0 1 14 0" />
      <path d="M8 12.5 a4 4 0 0 1 8 0" />
      <circle cx="12" cy="13" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  send: (
    <>
      <path d="M22 2 L11 13" />
      <path d="M22 2 L15 22 L11 13 L2 9 Z" />
    </>
  ),
  swap: (
    <>
      <path d="M7 4 L3 8 L7 12" />
      <path d="M3 8 H17" />
      <path d="M17 12 L21 16 L17 20" />
      <path d="M21 16 H7" />
    </>
  ),
  inbox: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 13 h5 l2 3 h4 l2-3 h5" />
    </>
  ),
  replay: (
    <>
      <path d="M3 12 a9 9 0 1 0 2.6-6.3" />
      <path d="M3 3 v4 h4" />
    </>
  ),
  beaker: (
    <>
      <path d="M9 3 v6 L4 19 a1.5 1.5 0 0 0 1.4 2 h13.2 a1.5 1.5 0 0 0 1.4-2 L15 9 V3" />
      <path d="M8 3 h8" />
      <path d="M7.2 15 h9.6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 L22 20 H2 Z" />
      <path d="M12 9 v5" />
      <circle cx="12" cy="17.4" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  link: (
    <>
      <path d="M9 15 L15 9" />
      <path d="M11 6 l1.5-1.5 a4 4 0 0 1 5.6 5.6 L16.5 12" />
      <path d="M13 18 l-1.5 1.5 a4 4 0 0 1-5.6-5.6 L7.5 12" />
    </>
  ),
  cog: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M4.9 4.9 l2.1 2.1 M17 17 l2.1 2.1 M19.1 4.9 l-2.1 2.1 M7 17 l-2.1 2.1" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2 v2 M12 20 v2 M2 12 h2 M20 12 h2 M4.9 4.9 l1.4 1.4 M17.7 17.7 l1.4 1.4 M19.1 4.9 l-1.4 1.4 M6.3 17.7 l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.5 A8 8 0 1 1 9.5 4 a6.5 6.5 0 0 0 10.5 10.5 Z" />,
  monitor: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3 M4.9 4.9 l2.1 2.1 M17 17 l2.1 2.1 M19.1 4.9 l-2.1 2.1 M7 17 l-2.1 2.1" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5 h0.01 M7 16.5 h0.01" />
    </>
  ),
  "panel-left": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4 V20" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20 l-3.5-3.5" />
    </>
  ),
  plus: <path d="M12 5 v14 M5 12 h14" />,
  x: <path d="M6 6 L18 18 M18 6 L6 18" />,
  trash: <path d="M4 7 h16 M9 7 V5 a1 1 0 0 1 1-1 h4 a1 1 0 0 1 1 1 v2 M6 7 l1 13 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1-1 l1-13" />,
  check: <path d="M4 12 l5 5 L20 6" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15 H4 a1 1 0 0 1-1-1 V4 a1 1 0 0 1 1-1 h10 a1 1 0 0 1 1 1 v1" />
    </>
  ),
  "chevron-down": <path d="M6 9 L12 15 L18 9" />,
  "chevron-right": <path d="M9 6 L15 12 L9 18" />,
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />,
  network: (
    <>
      <circle cx="5" cy="6" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M7 6 h10 M6.7 7.6 L10.5 16.2 M17.3 7.6 L13.5 16.2" />
    </>
  ),
};

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {ICONS[name] ?? ICONS.dot}
    </svg>
  );
}
