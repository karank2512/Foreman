import type { UserRole } from "@prisma/client";

/** The org-scoped identity every server action / query receives. Produced by requireSession(). */
export interface SessionContext {
  userId: string;
  organizationId: string;
  organizationName: string;
  role: UserRole;
  name: string;
  email: string;
}

export const DEMO_USER = {
  email: "demo@foreman.example",
  password: "demo1234",
  name: "Demo User",
  organizationName: "Acme Robotics",
  organizationSlug: "acme-robotics",
} as const;
