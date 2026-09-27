import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { config } from "@/server/config";
import { AuthNav } from "./_components/auth-nav";

export const metadata: Metadata = {
  // Absolute URLs for the share image the root's file convention attaches. Same fallback as the marketing layout.
  metadataBase: new URL(config.publicUrl ?? `http://localhost:${process.env.PORT ?? "3000"}`),
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

/**
 * Signed-out pages: a white page, the marketing bar, and one calm 400px column. No dot grid, no glow, no
 * card — the type carries it.
 */
export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  const signUpOpen = config.auth.signupMode !== "closed";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AuthNav signUpOpen={signUpOpen} />

      <main className="flex-1 px-4 pt-[clamp(40px,12vh,112px)] pb-24 sm:px-6">
        <div className="mx-auto w-full max-w-[400px]">{children}</div>
      </main>

      {/* Privacy and Terms pages aren't written yet, so the footer doesn't pretend to link to them. */}
      <footer className="px-4 pb-8 text-center text-[12px] leading-4 text-muted-foreground sm:px-6">
        <p>&copy; {new Date().getFullYear()} AI Staffing Agency</p>
      </footer>
    </div>
  );
}
