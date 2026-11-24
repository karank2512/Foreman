"use server";

import type { UserRole } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  changeMemberRole,
  changePassword,
  createInvitation,
  createPasswordResetLink,
  removeMember,
  revokeInvitation,
  signOutEverywhere,
  updateOrgSettings,
} from "@/server/account";
import { requireSession } from "@/server/auth";
import { runAction, type ActionResult } from "@/lib/action-result";

/**
 * Account and workspace mutations behind the settings page. Every one of them re-reads the session, lets
 * `@/server/account` decide whether the caller's role allows it, and revalidates /settings afterwards.
 * (The UI that calls these arrives in the design wave.)
 */

/** Rotating the password bumps `sessionVersion`, so every other device — and this one — signs out. */
export async function changePasswordAction(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    const s = await requireSession();
    await changePassword(s, input);
    revalidatePath("/settings");
  });
}

export async function signOutEverywhereAction(): Promise<ActionResult> {
  return runAction(async () => {
    const s = await requireSession();
    await signOutEverywhere(s);
    revalidatePath("/settings");
  });
}

/** Returns the link for the admin to share: there is no mail provider in this phase. */
export async function inviteMemberAction(input: {
  email: string;
  role: "MEMBER" | "ADMIN";
}): Promise<ActionResult<{ invitationId: string; inviteUrl: string; expiresAt: string }>> {
  return runAction(async () => {
    const s = await requireSession();
    const invitation = await createInvitation(s, input);
    revalidatePath("/settings");
    return invitation;
  });
}

export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  return runAction(async () => {
    const s = await requireSession();
    await revokeInvitation(s, invitationId);
    revalidatePath("/settings");
  });
}

export async function changeMemberRoleAction(userId: string, role: UserRole): Promise<ActionResult> {
  return runAction(async () => {
    const s = await requireSession();
    await changeMemberRole(s, userId, role);
    revalidatePath("/settings");
  });
}

export async function removeMemberAction(userId: string): Promise<ActionResult> {
  return runAction(async () => {
    const s = await requireSession();
    await removeMember(s, userId);
    revalidatePath("/settings");
  });
}

/** A one-time link for the owner to pass on by hand; making it signs the member out everywhere. */
export async function createPasswordResetLinkAction(
  userId: string,
): Promise<ActionResult<{ resetUrl: string; expiresAt: string }>> {
  return runAction(async () => {
    const s = await requireSession();
    const link = await createPasswordResetLink(s, userId);
    revalidatePath("/settings");
    return link;
  });
}

export async function updateOrgSettingsAction(input: {
  name?: string;
  monthlyBudgetUsd?: number | null;
}): Promise<ActionResult> {
  return runAction(async () => {
    const s = await requireSession();
    await updateOrgSettings(s, input);
    revalidatePath("/settings");
    revalidatePath("/usage");
  });
}
