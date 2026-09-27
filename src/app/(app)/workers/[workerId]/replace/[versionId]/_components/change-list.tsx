import { EmptyState } from "@/components/empty-state";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BlueprintDiffEntry } from "@/server/domain";
import { humanizeDiffEntry, type ChangeCopyContext } from "./change-copy";

const KIND_LABELS: Record<BlueprintDiffEntry["kind"], string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

const ROW =
  "relative px-5 py-4 sm:px-6 [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-x-5 [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:h-px [&:not(:first-child)]:before:bg-border sm:[&:not(:first-child)]:before:inset-x-6";

/** The blueprint diff as a readable change list: one row per entry, before → after, in a manager's words. */
export function ChangeList({
  entries,
  baseLabel,
  targetLabel,
  toolNames = {},
}: {
  entries: BlueprintDiffEntry[];
  baseLabel: string;
  targetLabel: string;
  toolNames?: ChangeCopyContext["toolNames"];
}) {
  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState title="Nothing changes" description={`${targetLabel} has the same design as ${baseLabel}.`} />
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <ol className="flex flex-col">
        {entries.map((raw) => humanizeDiffEntry(raw, { toolNames })).map((entry) => (
          <li key={`${entry.kind}:${entry.path}`} className={ROW}>
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-pretty">{entry.label}</p>
                <p className="text-footnote mt-0.5 text-muted-foreground">{KIND_LABELS[entry.kind]}</p>
              </div>
              <div className="min-w-0 space-y-1.5">
                {entry.kind !== "added" ? <Excerpt text={entry.before} before /> : null}
                {entry.kind !== "removed" ? <Excerpt text={entry.after} /> : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Excerpt({ text, before = false }: { text: string | undefined; before?: boolean }) {
  return (
    <p
      className={cn(
        "text-callout rounded-lg bg-muted px-3 py-2 text-pretty break-words",
        before ? "text-muted-foreground line-through decoration-input" : "text-foreground",
      )}
    >
      {text && text.length > 0 ? text : <span className="text-tertiary italic">empty</span>}
    </p>
  );
}
