import Link from "next/link";
import { RelativeTime } from "@/components/relative-time";
import { LogoGlyph } from "@/components/shell/logo";
import { WorkerAvatar } from "@/components/worker-avatar";
import { initialsOf } from "@/lib/initials";
import { cn } from "@/lib/utils";
import type { ActivityItem } from "@/server/activity";

/**
 * Who did it. A worker gets their face; a teammate gets their initials on a neutral circle; the platform gets
 * the wordmark glyph. No per-type icon — the sentence already says what happened.
 */
function Actor({ item }: { item: ActivityItem }) {
  if (item.worker) {
    return <WorkerAvatar name={item.worker.name} color={item.worker.avatarColor} size="sm" />;
  }
  const shell = "flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary select-none";
  if (item.actorType === "USER") {
    return (
      <span role="img" aria-label={item.actorName ?? "A teammate"} className={cn(shell, "text-xs font-semibold text-muted-foreground")}>
        {initialsOf(item.actorName)}
      </span>
    );
  }
  return (
    <span role="img" aria-label="Foreman" className={shell}>
      <LogoGlyph className="size-4 text-muted-foreground" />
    </span>
  );
}

export interface ActivityRowProps {
  item: ActivityItem;
  /** Dense = the "Recent activity" card on Workforce: one line per event, no by-line. */
  dense?: boolean;
}

/**
 * One feed entry: who did it, what happened in a sentence, and when. The whole row links to the most specific
 * page the event knows about (deliverable → approval → version → run → worker).
 */
export function ActivityRow({ item, dense = false }: ActivityRowProps) {
  // The sentence already names whoever acted ("Dana approved Maya's request"), so there is no by-line.
  const body = (
    <>
      <Actor item={item} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-body-app text-foreground", dense ? "truncate" : "text-pretty")}>{item.title}</p>
        {item.detail ? (
          <p className={cn("text-footnote text-pretty text-muted-foreground", dense ? "line-clamp-1" : "line-clamp-2")}>
            {item.detail}
          </p>
        ) : null}
      </div>
      <span className="text-footnote shrink-0 pt-0.5 text-muted-foreground tabular-nums">
        <RelativeTime iso={item.createdAt} />
      </span>
    </>
  );

  const rowClass = cn("flex items-start gap-3.5", dense ? "py-3" : "min-h-14 py-3.5");
  if (!item.href) return <div className={rowClass}>{body}</div>;

  return (
    <Link
      href={item.href}
      className={cn(
        rowClass,
        "-mx-3 rounded-lg px-3 transition-colors duration-200 ease-standard outline-none hover:bg-muted",
      )}
    >
      {body}
    </Link>
  );
}
