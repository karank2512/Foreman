import { cn } from "@/lib/utils";

/**
 * Our own mark: three nodes — one lead, two reports — joined by two strokes. Monochrome, no tile, no shadow,
 * no ring, so it reads as a wordmark glyph rather than an app icon. The favicon uses the same shape.
 */
export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("size-5 shrink-0 text-foreground", className)}>
      <path
        d="M12 9.2v3.1m0 0-4.6 3.2m4.6-3.2 4.6 3.2"
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="6.4" r="2.9" fill="currentColor" />
      <circle cx="6.4" cy="17.2" r="2.5" fill="currentColor" fillOpacity="0.72" />
      <circle cx="17.6" cy="17.2" r="2.5" fill="currentColor" fillOpacity="0.72" />
    </svg>
  );
}

export interface WordmarkProps {
  className?: string;
}

/** Glyph + name on one line, 15px/600. The only brand lockup in the product. */
export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoGlyph />
      <span className="text-[15px] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-foreground">
        Foreman
      </span>
    </span>
  );
}
