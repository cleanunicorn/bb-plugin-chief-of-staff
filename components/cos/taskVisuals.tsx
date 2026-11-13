import { Icon } from "../ui/icon";
import { toneColor, usePalette, type Tone } from "./viz";

/** Compact state pictogram; the adjacent status label supplies the accessible name. */
export function StateMark({ icon, tone }: { icon: string; tone: Tone }) {
  const color = toneColor(tone, usePalette());
  return <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg border" style={{ color, borderColor: `color-mix(in srgb, ${color} 24%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
    <Icon name={icon} fallback="Circle" className="size-4" />
  </span>;
}

/** A local, theme-aware illustration: no external avatars or image requests. */
export function QueueIllustration() {
  const { accent } = usePalette();
  return <svg aria-hidden viewBox="0 0 160 100" className="mb-2 h-24 w-40" fill="none">
    <ellipse cx="80" cy="88" rx="64" ry="7" fill="var(--muted)" />
    <rect x="24" y="27" width="91" height="54" rx="10" fill="var(--muted)" stroke="var(--border)" transform="rotate(-8 24 27)" />
    <rect x="38" y="16" width="96" height="65" rx="10" fill="var(--card)" stroke="var(--border)" />
    <rect x="48" y="28" width="27" height="27" rx="8" fill={accent} opacity=".12" />
    <g stroke={accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M55 44a4 4 0 0 1-1-7.8 3.5 3.5 0 0 1 6.5-1.2A4 4 0 0 1 65 42v7H55Z" />
      <path d="M55 46h10m-6-5v2m3-2v2" />
    </g>
    <path d="M85 35h36M85 44h25M50 66h18m8 0h18m8 0h18" stroke="var(--muted-foreground)" strokeOpacity=".35" strokeWidth="3" strokeLinecap="round" />
    <circle cx="130" cy="76" r="13" fill="var(--card)" stroke="var(--border)" />
    <path d="M130 70v12m-6-6h12" stroke={accent} strokeWidth="2" strokeLinecap="round" />
  </svg>;
}
