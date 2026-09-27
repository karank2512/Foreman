"use client";

import { useActionState, useState } from "react";
import { AuthField } from "../_components/field";
import { FormAlert, SubmitButton } from "../_components/form-ui";
import { PasswordField } from "../_components/password-field";
import { signUpAction } from "../actions";
import { FIELD_LIMITS, type SignUpState } from "../schema";

interface SignUpFormProps {
  /** SIGNUP_MODE=invite: the shared code the operator handed out. */
  inviteCodeRequired: boolean;
  passwordMinLength: number;
}

/**
 * Creates the workspace and its first owner, then signs in (the action redirects, so a success never comes
 * back as state). Inputs are controlled: React resets uncontrolled fields after a form action, which would
 * wipe everything typed on a failed attempt.
 *
 * There is no "I agree to the Terms" checkbox on purpose: no terms or privacy policy have been published, and
 * asking for consent to documents nobody can read is worse than saying so plainly under the button.
 */
export function SignUpForm({ inviteCodeRequired, passwordMinLength }: SignUpFormProps) {
  const [state, formAction, isPending] = useActionState<SignUpState, FormData>(signUpAction, { error: null });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  const error = isPending ? null : state.error;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {error ? <FormAlert id="sign-up-error">{error}</FormAlert> : null}

      <AuthField
        name="name"
        label="Full name"
        value={name}
        onValueChange={setName}
        autoComplete="name"
        required
        maxLength={FIELD_LIMITS.name}
        readOnly={isPending}
        invalid={Boolean(error)}
        describedBy={error ? "sign-up-error" : undefined}
      />

      <AuthField
        name="email"
        label="Work email"
        type="email"
        value={email}
        onValueChange={setEmail}
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        maxLength={FIELD_LIMITS.email}
        readOnly={isPending}
        invalid={Boolean(error)}
        describedBy={error ? "sign-up-error" : undefined}
      />

      <AuthField
        name="organizationName"
        label="Company name"
        value={organizationName}
        onValueChange={setOrganizationName}
        autoComplete="organization"
        required
        maxLength={FIELD_LIMITS.organizationName}
        readOnly={isPending}
        hint="This becomes your workspace. You can rename it later."
      />

      <PasswordField
        value={password}
        onChange={setPassword}
        minLength={passwordMinLength}
        context={{ email, name, organizationName }}
        readOnly={isPending}
      />

      {inviteCodeRequired ? (
        <AuthField
          name="inviteCode"
          label="Invite code"
          value={inviteCode}
          onValueChange={setInviteCode}
          required
          maxLength={FIELD_LIMITS.inviteCode}
          autoComplete="off"
          spellCheck={false}
          readOnly={isPending}
          hint="Sign-up is invite-only right now. Ask whoever sent you here."
        />
      ) : null}

      <div className="mt-2">
        <SubmitButton pending={isPending} label="Create account" pendingLabel="Creating account…" />
      </div>
      <p className="text-center text-[13px] leading-[18px] text-muted-foreground">
        Early access: there are no published terms or privacy policy yet. You&rsquo;ll be asked to accept them
        once they exist.
      </p>
    </form>
  );
}
