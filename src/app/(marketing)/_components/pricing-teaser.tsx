import Link from "next/link";
import { SIGN_UP_PATH } from "@/server/auth";
import { MarketingSection, SectionIntro, reveal } from "./section";
import { cn } from "@/lib/utils";

/**
 * No numbers. Nothing is billed yet and no price list exists, so the cards say what each tier is for and the
 * price line reads "Usage-based" — inventing a figure here would be the one lie on the page.
 */
interface Plan {
  name: string;
  description: string;
  price: string;
  priceNote: string;
  lines: string[];
  cta: { label: string; href: string };
  emphasized?: boolean;
}

const PLANS: Plan[] = [
  {
    name: "Starter",
    description: "For trying out your first worker.",
    price: "Free to start",
    priceNote: "Usage-based; bring your own model keys.",
    lines: [
      "One worker on a schedule",
      "Full run timeline and deliverables",
      "Approval gates on sensitive actions",
      "Monthly spend cap you set",
    ],
    cta: { label: "Get started", href: SIGN_UP_PATH },
  },
  {
    name: "Team",
    description: "For teams putting several workers on real jobs.",
    price: "Usage-based",
    priceNote: "Pricing coming soon.",
    lines: [
      "Unlimited workers and jobs",
      "Roles for owners, admins and members",
      "Performance reviews and version history",
      "Shared approvals queue",
    ],
    cta: { label: "Get started", href: SIGN_UP_PATH },
    emphasized: true,
  },
  {
    name: "Enterprise",
    description: "For custom controls, SSO, and volume.",
    // "Talk to us" would promise a sales path that doesn't exist yet; the button below is the only next step.
    price: "Custom",
    priceNote: "Pricing coming soon.",
    lines: [
      "Single sign-on",
      "Custom retention and audit export",
      "Private model endpoints",
      "Volume pricing",
    ],
    // No sales address to send anyone to yet, so every card does the one thing that works today.
    cta: { label: "Get started", href: SIGN_UP_PATH },
  },
];

export function PricingTeaser() {
  return (
    <MarketingSection id="pricing" tone="gray">
      <SectionIntro
        title="Pay for the work, not the seats."
        description="Start free, then pay for what your workers actually do. Every run is itemized."
      />

      <div className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {PLANS.map((plan, index) => (
          <div
            key={plan.name}
            {...reveal(index)}
            className={cn(
              // Never a ring and a shadow on the same card: the emphasised tier is marked by its border alone.
              "flex min-w-0 flex-col rounded-2xl bg-card p-7",
              plan.emphasized ? "ring-2 ring-primary" : "shadow-card",
            )}
          >
            <h3 className="text-title-2">{plan.name}</h3>
            <p className="mt-1.5 text-[15px] leading-[22px] text-muted-foreground">{plan.description}</p>

            <p className="mt-6 text-[22px] leading-7 font-semibold tracking-[-0.012em]">{plan.price}</p>
            <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground">{plan.priceNote}</p>

            <ul className="mt-6 flex-1 space-y-2.5">
              {plan.lines.map((line) => (
                <li key={line} className="text-[15px] leading-[22px] text-muted-foreground">
                  {line}
                </li>
              ))}
            </ul>

            <div className="mt-8">
              <Link
                href={plan.cta.href}
                className={cn(
                  "inline-flex h-11 w-full items-center justify-center rounded-full px-5.5 text-[17px] font-medium transition-colors duration-200 ease-standard",
                  plan.emphasized
                    ? "bg-primary text-primary-foreground hover:bg-primary-hover"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary-hover",
                )}
              >
                {plan.cta.label}
              </Link>
            </div>
          </div>
        ))}
      </div>

      <p {...reveal(3)} className="mt-8 text-center text-[13px] leading-[18px] text-muted-foreground">
        Prices aren&rsquo;t set yet, so we haven&rsquo;t made any up. Nothing is charged today.
      </p>
    </MarketingSection>
  );
}
