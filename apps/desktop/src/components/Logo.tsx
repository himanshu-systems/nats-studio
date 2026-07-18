import { useId } from "react";

/**
 * The NATS Studio brand mark: an "N" monogram in a blue→teal gradient on a
 * deep-navy rounded square — an inline SVG recreation of the app icon (offline,
 * crisp at any size, theme-independent).
 */
export function Logo({
  size = 28,
  rounded = true,
}: {
  size?: number;
  rounded?: boolean;
}): JSX.Element {
  const gid = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="NATS Studio"
      className="shrink-0"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2e8de8" />
          <stop offset="1" stopColor="#27c6a0" />
        </linearGradient>
      </defs>
      {rounded && <rect x="0" y="0" width="100" height="100" rx="24" fill="#131a29" />}
      <path
        d="M32 72 V34 L60 66 V30"
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={13}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
