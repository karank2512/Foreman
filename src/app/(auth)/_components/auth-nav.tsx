"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoGlyph } from "@/components/shell/logo";

// Literal paths: a client component must not value-import anything under `@/server` (CLAUDE.md rule 8).
const SIGN_IN_PATH = "/sign-in";
const SIGN_UP_PATH = "/sign-up";

/**
 * The marketing bar, stripped to a wordmark and the one link the visitor is not already on. Client-side only
 * so it can read the pathname; there is no menu here, because there is nowhere else to go.
 */
export function AuthNav({ signUpOpen }: { signUpOpen: boolean }) {
  const pathname = usePathname() ?? "";
  const onSignIn = pathname.startsWith(SIGN_IN_PATH);
  const link = onSignIn
    ? signUpOpen
      ? { href: SIGN_UP_PATH, label: "Create account" }
      : null
    : { href: SIGN_IN_PATH, label: "Sign in" };

  return (
    <header className="sticky top-0 z-40 h-(--nav-height) bg-[rgb(251_251_253_/_0.8)] shadow-[inset_0_-0.5px_0_var(--hairline)] backdrop-blur-[20px] backdrop-saturate-[180%]">
      <div className="mx-auto flex h-full w-full max-w-(--container-app) items-center px-4 sm:px-6">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 rounded-sm outline-none">
          <LogoGlyph />
          <span className="text-[15px] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap">
            Foreman
          </span>
        </Link>

        {link ? (
          <Link
            href={link.href}
            // 44px tall and padded sideways for the thumb; the negative margin keeps the text flush right.
            className="text-footnote -mr-3 ml-auto inline-flex h-11 items-center rounded-sm px-3 font-medium text-link outline-none hover:underline"
          >
            {link.label}
          </Link>
        ) : null}
      </div>
    </header>
  );
}
