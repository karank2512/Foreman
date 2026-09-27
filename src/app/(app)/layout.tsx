import type { ReactNode } from "react";
import type { Viewport } from "next";
import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/server/auth";
import { can } from "@/server/auth/permissions";
import { getShellData } from "@/server/queries/shell";

/** The app sits on the #f5f5f7 canvas, so the browser chrome should match it rather than the marketing white. */
export const viewport: Viewport = {
  themeColor: "#f5f5f7",
  colorScheme: "light",
};

/** Everything under (app) is authenticated: `requireSession()` redirects to /sign-in when there is no session. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const s = await requireSession();
  const shell = await getShellData(s.organizationId);

  return (
    <AppShell
      user={{
        name: s.name,
        email: s.email,
        organizationName: s.organizationName,
        // Hiring is ADMIN+ (docs/PRODUCTION.md); the chrome hides its Hire actions from everyone else.
        canHire: can(s.role, "workers.hire"),
      }}
      simulated={shell.simulated}
      pendingApprovals={shell.pendingApprovals}
    >
      {children}
    </AppShell>
  );
}
