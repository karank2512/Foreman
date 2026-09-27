import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { getSession } from "@/server/auth";
import { can } from "@/server/auth/permissions";
import { getShellData } from "@/server/queries/shell";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Root 404 — served for URLs outside any route group (and for `notFound()` on public pages). Deliberately says
 * nothing about whether the thing exists for someone else.
 *
 * A signed-in visitor gets the app's own chrome around it (the same shell `(app)/layout.tsx` renders), so the
 * nav is right there to carry on from, and no "Sign in" prompt for an account they are already using. A stale
 * cookie counts as signed out: `getSession()` re-checks it against the database.
 */
export default async function RootNotFound() {
  const s = await getSession();

  if (s) {
    const shell = await getShellData(s.organizationId);
    return (
      <AppShell
        user={{
          name: s.name,
          email: s.email,
          organizationName: s.organizationName,
          canHire: can(s.role, "workers.hire"),
        }}
        simulated={shell.simulated}
        pendingApprovals={shell.pendingApprovals}
      >
        <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
          <h1 className="text-title-2 text-balance">We couldn&apos;t find that page.</h1>
          <p className="text-body mt-3 max-w-[44ch] text-muted-foreground">
            The link may be out of date, or the page may have moved.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" asChild>
              <Link href="/workforce">Go to Workforce</Link>
            </Button>
            <Button variant="link" asChild>
              <Link href="/activity">View activity ›</Link>
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col items-center justify-center px-4 text-center">
      <h1 className="text-headline text-balance">We couldn&apos;t find that page.</h1>
      <p className="text-body mt-3 text-muted-foreground">
        The link may be out of date, or the page may have moved.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/workforce"
          className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-5.5 text-[17px] font-medium text-primary-foreground transition-colors duration-200 hover:bg-primary-hover"
        >
          Go to Workforce
        </Link>
        <Link href="/sign-in" className="text-[15px] font-medium text-link transition-opacity hover:opacity-70">
          Sign in ›
        </Link>
      </div>
    </main>
  );
}
