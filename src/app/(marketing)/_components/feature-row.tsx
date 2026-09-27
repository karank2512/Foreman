import type { ReactNode } from "react";
import { MarketingSection, reveal, type SectionTone } from "./section";
import { cn } from "@/lib/utils";

export interface FeatureRowProps {
  id?: string;
  tone?: SectionTone;
  /** At most one per section, in warning orange. */
  eyebrow?: string;
  title: string;
  body: string;
  /** Optional tertiary link; rendered as blue text with a chevron. */
  link?: { href: string; label: string };
  mock: ReactNode;
  /** Put the mock on the left and the words on the right (alternates down the page). */
  mockFirst?: boolean;
}

/**
 * A words-and-mock band: half text, half real product UI, stacked on phones. The explicit `grid-cols-1`
 * (minmax(0,1fr)) and `min-w-0` matter: an implicit auto track sizes to a child's max-content, so one nowrap
 * line inside a mock would widen the whole page on a phone.
 */
export function FeatureRow({ id, tone = "white", eyebrow, title, body, link, mock, mockFirst = false }: FeatureRowProps) {
  return (
    <MarketingSection id={id} tone={tone}>
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div className={cn("min-w-0", mockFirst && "lg:order-2")}>
          {eyebrow ? (
            <p {...reveal(0)} className="mb-3 text-[17px] leading-6 font-semibold text-warning">
              {eyebrow}
            </p>
          ) : null}
          <h2 {...reveal(1)} className="text-headline max-w-[16ch]">
            {title}
          </h2>
          <p {...reveal(2)} className="mt-5 max-w-[46ch] text-[19px] leading-[28px] text-muted-foreground">
            {body}
          </p>
          {link ? (
            <p {...reveal(3)} className="mt-6">
              {/* 44px hit area on a 25px line: the vertical padding is cancelled by the negative margin. */}
              <a
                href={link.href}
                className="-my-[10px] inline-block py-[10px] text-[17px] leading-[25px] font-medium text-link hover:underline"
              >
                {link.label} <span aria-hidden>›</span>
              </a>
            </p>
          ) : null}
        </div>

        <div {...reveal(2)} className={cn("min-w-0", mockFirst && "lg:order-1")}>
          {mock}
        </div>
      </div>
    </MarketingSection>
  );
}
