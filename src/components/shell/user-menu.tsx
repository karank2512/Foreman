"use client";

import { useTransition } from "react";
import Link from "next/link";
import { signOutAction } from "@/app/(auth)/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ACCOUNT_ITEMS } from "@/components/shell/nav-items";
import { initialsOf } from "@/lib/initials";

export interface ShellUser {
  name: string;
  email: string;
  organizationName: string;
  /** `can(role, "workers.hire")` — whether the chrome shows the Hire pill and "Hire a worker". */
  canHire: boolean;
}

/**
 * Right end of the global nav: a 28px org monogram that opens the account menu. Usage and Settings live here so
 * the bar itself stays at four destinations.
 */
export function UserMenu({ user }: { user: ShellUser }) {
  const [signingOut, startSignOut] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${user.organizationName}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background transition-opacity duration-200 outline-none hover:opacity-85 data-[state=open]:opacity-85"
        >
          <span aria-hidden="true">{initialsOf(user.organizationName)}</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="min-w-60">
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-3 py-2 font-normal">
          <span className="truncate text-[15px] font-semibold text-foreground">{user.organizationName}</span>
          <span className="truncate text-footnote text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ACCOUNT_ITEMS.map((item) => (
          <DropdownMenuItem key={item.href} asChild>
            <Link href={item.href}>{item.label}</Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            // Keep the menu open while the server action runs; the action redirects when it lands.
            event.preventDefault();
            startSignOut(async () => {
              await signOutAction();
            });
          }}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
