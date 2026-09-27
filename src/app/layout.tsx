import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

/**
 * Typography: `--font-sans` / `--font-display` (globals.css) start with the OS system stack, so Apple devices
 * render their own UI font and switch optical sizes by themselves. Inter is the fallback everywhere else — it is
 * the only font file we ship, and no third-party display font is bundled or downloaded.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "AI Staffing Agency", template: "%s · AI Staffing Agency" },
  description:
    "Describe the job in plain English. We scope it, design an AI worker for it, and put them on a schedule — with every deliverable reviewed, scored and yours to keep.",
  applicationName: "AI Staffing Agency",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // `x-nonce` is the per-response CSP nonce set by src/middleware.ts. Reading a request header also opts every
  // route into dynamic rendering, which is what keeps the nonce in the response header matching the HTML — a
  // prerendered page would bake in a stale one. The app ships no inline <script>, so there is nothing to forward
  // the value to; the marker below only records that the CSP pipeline is wired.
  const nonce = (await headers()).get("x-nonce");

  return (
    // The Inter variable lives on <html> so `font-sans` / `font-display` resolve everywhere, portals included.
    // `data-scroll-behavior` tells Next.js we set `scroll-behavior: smooth` on purpose (globals.css), so it keeps
    // disabling it during route transitions instead of warning on every client navigation.
    <html
      lang="en"
      className={inter.variable}
      data-csp={nonce ? "nonce" : undefined}
      data-scroll-behavior="smooth"
    >
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        {/* Theme is pinned: the shadcn wrapper defaults to "system", which would render dark toasts on dark-mode OSes. */}
        <Toaster position="top-center" theme="light" />
      </body>
    </html>
  );
}
