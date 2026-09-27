import type { AvatarColor } from "@/server/domain";
import { initialsOf } from "@/lib/initials";
import { cn } from "@/lib/utils";

/**
 * FULL static class strings — Tailwind only generates classes it can see verbatim in source, so never build
 * these with template strings. Typed by `AvatarColor` (type-only import) so adding a token to `AVATAR_COLORS`
 * in the domain fails the build until it has classes here.
 *
 * Every entry is a pastel fill (~94% lightness) with same-hue initials at ~40% lightness: readable, never
 * saturated, never a gradient. The `violet` and `indigo` tokens predate the redesign and now render in lime and
 * cyan: there is no purple or indigo anywhere in this design (docs/DESIGN.md), and the tokens are frozen.
 */
const AVATAR_COLOR_CLASSES: Record<AvatarColor, string> = {
  violet: "bg-lime-100 text-lime-800",
  sky: "bg-sky-100 text-sky-700",
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-800",
  rose: "bg-rose-100 text-rose-700",
  indigo: "bg-cyan-100 text-cyan-700",
  teal: "bg-teal-100 text-teal-700",
  orange: "bg-orange-100 text-orange-700",
};

const SIZE_CLASSES = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-12 text-base",
  xl: "size-18 text-2xl",
} as const;

/** An unknown token gets neutral gray rather than a hue — a borrowed colour would read as a different worker. */
const FALLBACK_CLASSES = "bg-secondary text-muted-foreground";

function isAvatarColor(color: string): color is AvatarColor {
  return Object.prototype.hasOwnProperty.call(AVATAR_COLOR_CLASSES, color);
}

export interface WorkerAvatarProps {
  /** Worker persona name; initials are derived from it. */
  name: string;
  /** `Worker.avatarColor` — one of the domain `AVATAR_COLORS` tokens. Unknown values fall back to neutral gray. */
  color: string;
  /** xs 24px (dense rows) · sm 32px · md 40px (default) · lg 48px (cards) · xl 72px (profile, résumé). */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

/** A worker's face everywhere in the product: initials on a soft tinted circle. */
export function WorkerAvatar({ name, color, size = "md", className }: WorkerAvatarProps) {
  const tint = isAvatarColor(color) ? AVATAR_COLOR_CLASSES[color] : FALLBACK_CLASSES;
  return (
    <span
      data-slot="worker-avatar"
      role="img"
      aria-label={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight select-none",
        SIZE_CLASSES[size],
        tint,
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
