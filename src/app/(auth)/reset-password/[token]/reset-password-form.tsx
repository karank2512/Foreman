"use client";

import { useActionState, useState } from "react";
import { AuthStaticField } from "../../_components/field";
import { FormAlert, SubmitButton } from "../../_components/form-ui";
import { PasswordField } from "../../_components/password-field";
import { resetPasswordAction } from "../../actions";
import type { ResetPasswordState } from "../../schema";

interface ResetPasswordFormProps {
  token: string;
  /** Fixed by the link — shown, never editable. */
  email: string;
  name: string;
  organizationName: string;
  passwordMinLength: number;
}

export function ResetPasswordForm({ token, email, name, organizationName, passwordMinLength }: ResetPasswordFormProps) {
  const [state, formAction, isPending] = useActionState<ResetPasswordState, FormData>(resetPasswordAction, {
    error: null,
  });
  const [password, setPassword] = useState("");

  const error = isPending ? null : state.error;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      {error ? <FormAlert id="reset-password-error">{error}</FormAlert> : null}

      <AuthStaticField label="Account" value={email} />

      <PasswordField
        value={password}
        onChange={setPassword}
        minLength={passwordMinLength}
        context={{ email, name, organizationName }}
        readOnly={isPending}
        label="New password"
      />

      <div className="mt-2">
        <SubmitButton pending={isPending} label="Set new password" pendingLabel="Setting your password…" />
      </div>
    </form>
  );
}
