import type { Metadata } from "next";
import Link from "next/link";
import { getPasswordResetByToken } from "@/server/account";
import { SIGN_IN_PATH } from "@/server/auth";
import { config } from "@/server/config";
import { AuthHeader } from "../../_components/form-ui";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = {
  title: "Choose a new password",
  description: "Use your one-time link to choose a new password for your Foreman account.",
  robots: { index: false, follow: false },
};

/**
 * One-time password reset. Unknown, expired, already-used and superseded links all look the same here, so a
 * stranger learns nothing by guessing.
 */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reset = await getPasswordResetByToken(token);

  if (!reset) {
    return (
      <>
        <AuthHeader
          title="This reset link has expired"
          description="Reset links work once, for a day, and only the newest one works. Ask a workspace owner to make you a fresh one from Settings → Members."
        />
        <p className="text-[15px] leading-[22px] text-muted-foreground">
          Remembered it after all?{" "}
          <Link href={SIGN_IN_PATH} className="-my-[11px] inline-block py-[11px] font-medium text-link hover:underline">
            Sign in <span aria-hidden>›</span>
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <AuthHeader
        title="Choose a new password"
        description={`For your account in ${reset.organizationName}. You'll be signed in as soon as it's set, and signed out everywhere else.`}
      />

      <ResetPasswordForm
        token={token}
        email={reset.email}
        name={reset.name}
        organizationName={reset.organizationName}
        passwordMinLength={config.auth.passwordMinLength}
      />
    </>
  );
}
