import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SESSION_EXPIRED_PARAM, SIGN_UP_PATH, getSession, safeCallbackUrl } from "@/server/auth";
import { DEMO_USER } from "@/server/auth/types";
import { config } from "@/server/config";
import { AuthHeader } from "../_components/form-ui";
import { SIGN_IN_MESSAGES } from "../schema";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Foreman workspace to check on your workers and review their work.",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function SignInPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(first(params.callbackUrl));

  // The middleware already turns away visitors with a valid cookie; this DB-verified check also covers
  // the `?expired=1` escape hatch being opened by someone whose session is in fact fine.
  if (await getSession()) redirect(callbackUrl);

  const sessionExpired = first(params[SESSION_EXPIRED_PARAM]) !== undefined;

  // Auth.js appends `?error=<type>` when a sign-in made through its HTTP endpoint (not our form action) fails.
  const errorType = first(params.error);
  const initialError =
    errorType === undefined
      ? null
      : errorType === "CredentialsSignin"
        ? SIGN_IN_MESSAGES.invalidCredentials
        : SIGN_IN_MESSAGES.unexpected;

  // Demo credentials reach the browser ONLY for a deployment that opted in (DEMO_MODE=true). Anywhere else
  // the form starts empty and nothing hints that a shared account exists.
  const demo = config.auth.demoMode
    ? { email: DEMO_USER.email, password: DEMO_USER.password, organizationName: DEMO_USER.organizationName }
    : null;
  const signUpOpen = config.auth.signupMode !== "closed";

  return (
    <>
      <AuthHeader title="Sign in" description="Pick up where your team left off." />

      <SignInForm
        callbackUrl={callbackUrl}
        sessionExpired={sessionExpired}
        initialError={initialError}
        demo={demo}
      />

      {signUpOpen ? (
        <p className="mt-10 border-t border-border pt-6 text-[15px] leading-[22px] text-muted-foreground">
          New to Foreman?{" "}
          <Link href={SIGN_UP_PATH} className="-my-[11px] inline-block py-[11px] font-medium text-link hover:underline">
            Create an account <span aria-hidden>›</span>
          </Link>
        </p>
      ) : null}
    </>
  );
}
