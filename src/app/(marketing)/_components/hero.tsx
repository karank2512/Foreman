import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DEFAULT_SIGNED_IN_PATH, SIGN_UP_PATH } from "@/server/auth";
import { WorkforceMock } from "./mock-workforce";

/**
 * Above the fold, so nothing here takes part in the scroll reveal: the headline and calls to action are the
 * page's first paint and must not wait for hydration. The showcase frame keeps its 600ms rise as a CSS
 * animation (`.marketing-hero-rise` in ../marketing.css), which also runs before any JavaScript.
 */
export function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="bg-background px-4 pt-[clamp(72px,9vw,120px)] sm:px-6">
      <div className="mx-auto w-full max-w-(--container-marketing) text-center">
        <h1 className="text-display-xl mx-auto max-w-[15ch]">Describe the job. Meet your new hire.</h1>

        <p className="text-body-lg mx-auto mt-6 max-w-[640px] text-muted-foreground">
          Tell us what needs doing in plain English. We scope the work, design an AI worker for it, and put them on a
          schedule. Every deliverable is reviewed, scored, and yours to keep. If it isn&rsquo;t working, you replace
          them in a click.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button asChild size="xl" className="w-full sm:w-auto">
            <Link href={signedIn ? DEFAULT_SIGNED_IN_PATH : SIGN_UP_PATH}>
              {signedIn ? "Open workforce" : "Get started"}
            </Link>
          </Button>
          <Button asChild size="xl" variant="secondary" className="w-full sm:w-auto">
            <a href="#how">See how it works</a>
          </Button>
        </div>

        <p className="mt-5 text-[13px] leading-[18px] text-muted-foreground">
          Free and open source. Runs on your own machine, with your own model key or none at all.
        </p>
      </div>

      {/* The frame is the same #f5f5f7 as the band below, so the bleed reads as the page opening into it. */}
      <div className="marketing-hero-rise relative z-10 mx-auto mt-16 -mb-14 w-full max-w-(--container-marketing) sm:-mb-20">
        <WorkforceMock />
      </div>
    </section>
  );
}
