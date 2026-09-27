import type { SecurityEventType } from "@prisma/client";
import type { SecurityEventView } from "@/server/security";

/**
 * Shapes the audit trail for reading. Pure — the section is a server component, but the rules are easier to
 * test (and to reason about) without React around them.
 */

export interface ActivityRow {
  /** The newest event in the group; stable enough for a React key. */
  id: string;
  type: SecurityEventType;
  userId: string | null;
  /** A public address, or null when the address would tell the reader nothing (see `publicIp`). */
  ip: string | null;
  /** How many identical events folded into this row. */
  count: number;
  /** ISO time of the newest event in the group. */
  latestAt: string;
}

/** How many rows the section shows after folding; the page fetches a few times more so folding has material. */
export const ACTIVITY_ROW_LIMIT = 12;

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\.0\.0\.0$/,
];

/**
 * Loopback, link-local and private-range addresses only say "same machine" or "same network", which on a
 * laptop demo turns every row into "signed in from ::1". Those, and the limiter's "unknown", render as
 * nothing at all; a routable address is kept because it is the one thing that helps spot a stranger.
 */
export function publicIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let address = ip.trim().toLowerCase();
  if (address === "" || address === "unknown") return null;
  // IPv4 carried inside IPv6 (`::ffff:192.168.1.8`): judge the IPv4 part.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) address = mapped[1];
  if (address === "::1" || address === "::") return null;
  if (address.includes(":")) {
    // fc00::/7 (unique local) and fe80::/10 (link-local).
    if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return null;
    return ip.trim();
  }
  if (PRIVATE_V4.some((range) => range.test(address))) return null;
  return ip.trim();
}

/**
 * Folds a run of identical events — same kind, same person, same place — into one row with a count, so a
 * dozen sign-ins from one laptop read as one line instead of a wall. Events arrive newest first and stay
 * that way; only *consecutive* repeats fold, so "signed in, changed password, signed in" keeps its order.
 */
export function collapseActivity(events: SecurityEventView[], limit = ACTIVITY_ROW_LIMIT): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const event of events) {
    const ip = publicIp(event.ip);
    const last = rows[rows.length - 1];
    if (last && last.type === event.type && last.userId === event.userId && last.ip === ip) {
      last.count += 1;
      continue;
    }
    if (rows.length === limit) break;
    rows.push({ id: event.id, type: event.type, userId: event.userId, ip, count: 1, latestAt: event.createdAt });
  }
  return rows;
}
