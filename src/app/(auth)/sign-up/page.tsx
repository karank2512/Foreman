import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DEFAULT_SIGNED_IN_PATH, SIGN_IN_PATH, getSession } from "@/server/auth";
import { config } from "@/server/config";
import { AuthHeader } from "../_components/form-ui";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Create a Foreman workspace. Describe a job in plain English and put your first AI worker on it today.",
};

/**
 * Self-serve sign-up. `SIGNUP_MODE` decides whether this page can do anything at all — and the same check
 * runs inside `signUp()`, so a direct POST to the action gets the identical refusal.
 */
export default async function SignUpPage() {
  if (await getSession()) redirect(DEFAULT_SIGNED_IN_PATH);

  const mode = config.auth.signupMode;

  if (mode === "closed") {
    return (
      <>
        <AuthHeader
          title="Sign-up is closed"
          description="New workspaces aren't open on this deployment. Ask a workspace admin to send you an invite — the link they generate creates your account."
        />
        <p className="text-[15px] leading-[22px] text-muted-foreground">
          Already have an account?{" "}
          <Link href={SIGN_IN_PATH} className="-my-[11px] inline-block py-[11px] font-medium text-link hover:underline">
            Sign in <span aria-hidden>›</span>
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <AuthHeader title="Create your account" description="Your first worker can be on the job today." />

      <SignUpForm inviteCodeRequired={mode === "invite"} passwordMinLength={config.auth.passwordMinLength} />

      <p className="mt-10 border-t border-border pt-6 text-[15px] leading-[22px] text-muted-foreground">
        Already have an account?{" "}
        <Link href={SIGN_IN_PATH} className="-my-[11px] inline-block py-[11px] font-medium text-link hover:underline">
          Sign in <span aria-hidden>›</span>
        </Link>
      </p>
    </>
  );
}
