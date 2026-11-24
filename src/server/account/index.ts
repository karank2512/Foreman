/**
 * `@/server/account` — everything about who can get into a workspace and who they are once inside:
 * the password policy, self-serve sign-up, password changes and session revocation, membership,
 * invitations, and workspace settings.
 *
 * Server-only. App code reaches it through the server actions in `src/app/(auth)` and
 * `src/app/(app)/settings/account-actions.ts`; other server modules may import it directly.
 * Every mutation takes a `SessionContext` and is organization-scoped; permissions are enforced here
 * (via `assertCan`), never in the page that happens to call it.
 */

export { checkPasswordPolicy, assertPasswordPolicy } from "./password-policy";
export type { PasswordPolicyContext, PasswordPolicyResult } from "./password-policy";
export { COMMON_PASSWORDS } from "./common-passwords";

export { signUp, slugify } from "./sign-up";
export type { SignUpContext } from "./sign-up";

export { changePassword, signOutEverywhere } from "./security-settings";

export { listMembers, changeMemberRole, removeMember } from "./members";

export {
  acceptInvitation,
  createInvitation,
  getInvitationByToken,
  inviteUrlFor,
  listInvitations,
  revokeInvitation,
} from "./invitations";
export type { AcceptInvitationContext } from "./invitations";

export {
  PASSWORD_RESET_TTL_HOURS,
  createPasswordResetLink,
  createPasswordResetLinkForOperator,
  getPasswordResetByToken,
  passwordResetUrlFor,
  resetPasswordWithToken,
} from "./password-reset";
export type { ResetPasswordContext } from "./password-reset";

export { getOrgSettings, updateOrgSettings } from "./org-settings";

export {
  AcceptInvitationInputSchema,
  ChangePasswordInputSchema,
  CreateInvitationInputSchema,
  ResetPasswordInputSchema,
  SignUpInputSchema,
  UpdateOrgSettingsInputSchema,
  inviteTokenSchema,
  resetTokenSchema,
} from "./inputs";
export type {
  AcceptInvitationInput,
  ChangePasswordInput,
  CreateInvitationInput,
  ResetPasswordInput,
  SignUpInput,
  UpdateOrgSettingsInput,
} from "./inputs";

export type {
  InvitationStatus,
  InvitationView,
  MemberView,
  OrgBudgetView,
  OrgSettingsView,
} from "./views";
