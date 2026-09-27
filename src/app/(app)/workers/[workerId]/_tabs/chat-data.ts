import { cache } from "react";
import type { UserRole } from "@prisma/client";
import { getWorkerChat } from "@/server/queries/worker-manage";

/**
 * One chat load per request. The header's Run now dialog needs the count of one-off instructions queued from the
 * chat, and the chat tab needs the whole conversation; on the chat tab both read this single result. Arguments
 * are primitives so React's per-request cache can match them.
 */
export const loadWorkerChat = cache((organizationId: string, workerId: string, role: UserRole) =>
  getWorkerChat(organizationId, workerId, { role }),
);
