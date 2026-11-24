import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "@/server/auth/password";
import { normalizeEmail } from "@/server/auth/authorize";

/**
 * Shape validation for everything that enters the account module. Deliberately *shape only* — the password
 * policy lives in `password-policy.ts` so its refusals can be explained one sentence at a time, and length
 * here is only an upper bound that stops a huge body from becoming hashing work.
 */

export const NAME_MAX = 80;
export const ORG_NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const INVITE_CODE_MAX = 200;

export const nameSchema = z.string().trim().min(1, "Enter your name").max(NAME_MAX, `Keep the name under ${NAME_MAX} characters`);

export const emailSchema = z
  .string()
  .trim()
  .max(EMAIL_MAX, "That email address is too long")
  .pipe(z.email("Enter a valid email address"))
  .transform(normalizeEmail);

export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, "Give the workspace a name")
  .max(ORG_NAME_MAX, `Keep the workspace name under ${ORG_NAME_MAX} characters`);

/** Bounded, not judged: `checkPasswordPolicy` decides whether it is good enough. */
export const rawPasswordSchema = z.string().min(1, "Choose a password").max(MAX_PASSWORD_LENGTH, "That password is too long");

export const SignUpInputSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: rawPasswordSchema,
  organizationName: organizationNameSchema,
  inviteCode: z.string().max(INVITE_CODE_MAX).optional(),
});
export type SignUpInput = z.infer<typeof SignUpInputSchema>;

export const ChangePasswordInputSchema = z.object({
  currentPassword: rawPasswordSchema,
  newPassword: rawPasswordSchema,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

export const CreateInvitationInputSchema = z.object({
  email: emailSchema,
  // OWNER is deliberately absent: only an existing owner can promote someone, and only after they join.
  role: z.enum(["MEMBER", "ADMIN"]),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationInputSchema>;

export const AcceptInvitationInputSchema = z.object({
  name: nameSchema,
  password: rawPasswordSchema,
});
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationInputSchema>;

export const UpdateOrgSettingsInputSchema = z
  .object({
    name: organizationNameSchema.optional(),
    /** null clears the override and falls back to the platform default. */
    monthlyBudgetUsd: z.number().min(0, "A budget cannot be negative").max(1_000_000).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.monthlyBudgetUsd !== undefined, "Nothing to change");
export type UpdateOrgSettingsInput = z.infer<typeof UpdateOrgSettingsInputSchema>;

export const ResetPasswordInputSchema = z.object({
  password: rawPasswordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordInputSchema>;

/** `<userId>.<expiresAt unix seconds>.<base64url HMAC-SHA256>` — see `password-reset.ts`. */
export const resetTokenSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]{1,64}\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$/, "That reset link is not valid");

/** Invitation tokens are 32 random bytes, hex-encoded. Anything else cannot match a stored hash. */
export const inviteTokenSchema = z.string().trim().regex(/^[0-9a-f]{64}$/, "That invite link is not valid");
