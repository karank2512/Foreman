import Link from "next/link";
import { Button } from "@/components/ui/button";
import { REPO_URL } from "@/lib/project";
import { SIGN_UP_PATH } from "@/server/auth";
import { MarketingSection, SectionIntro, reveal } from "./section";

/**
 * Foreman is Apache 2.0 licensed and runs on the visitor's own machine with their own model key. There is no hosted
 * version, no plan and no price, so this section says that plainly instead of showing pricing tiers.
 */
const POINTS: { title: string; body: string }[] = [
  {
    title: "Runs on your machine",
    body: "Clone it, run docker compose up, open localhost. Your workspace and its data stay in your own database. There is no account with anyone.",
  },
  {
    title: "Bring your own model key",
    body: "Add an Anthropic, OpenAI or Google key and every call is billed by that provider to your account. Foreman adds nothing on top, and caps spend per run and per month.",
  },
  {
    title: "Free to try, no key needed",
    body: "Without a key, the whole product runs on a built-in simulator: hiring, runs, reviews and Replace. It costs nothing and is clearly marked Simulated.",
  },
];

export function OpenSource() {
  return (
    <MarketingSection id="open-source" tone="gray">
      <SectionIntro
        title="Free and open source."
        description="Foreman is open source under the Apache 2.0 license. Run it yourself, read every line, and change what you like."
      />

      <div className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {POINTS.map((point, index) => (
          <div key={point.title} {...reveal(index)} className="flex min-w-0 flex-col rounded-2xl bg-card p-7 shadow-card">
            <h3 className="text-title-2">{point.title}</h3>
            <p className="mt-3 text-[15px] leading-[22px] text-muted-foreground">{point.body}</p>
          </div>
        ))}
      </div>

      <div {...reveal(3)} className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
        <Button asChild size="xl" className="w-full sm:w-auto">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
        </Button>
        <Button asChild size="xl" variant="secondary" className="w-full sm:w-auto">
          <Link href={SIGN_UP_PATH}>Create a workspace</Link>
        </Button>
      </div>
    </MarketingSection>
  );
}
