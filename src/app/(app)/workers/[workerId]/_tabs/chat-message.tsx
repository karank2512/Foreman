"use client";

import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { RelativeTime } from "@/components/relative-time";
import { WorkerAvatar } from "@/components/worker-avatar";
import { cn } from "@/lib/utils";
import type { ChatMessageView } from "@/server/queries/worker-manage";

/** How a message reads to the manager: the worker either answers, remembers for next time, or asks to change. */
export const CLASSIFICATION_META: Record<NonNullable<ChatMessageView["classification"]>, { label: string }> = {
  QUESTION: { label: "Question" },
  TEMPORARY_INSTRUCTION: { label: "Just this once" },
  SPEC_CHANGE: { label: "From now on" },
};

export interface ChatMessageProps {
  message: ChatMessageView;
  worker: { name: string; avatarColor: string };
  /** Local echo of a message whose send is still in flight. */
  pending?: boolean;
}

export function ChatMessage({ message, worker, pending = false }: ChatMessageProps) {
  if (message.role === "USER") return <UserBubble message={message} pending={pending} />;
  return <WorkerBubble message={message} worker={worker} />;
}

function UserBubble({ message, pending }: { message: ChatMessageView; pending: boolean }) {
  const meta = message.classification ? CLASSIFICATION_META[message.classification] : null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div
        className={cn(
          "max-w-[85%] rounded-[18px] bg-primary px-4 py-2.5 text-[15px] leading-[1.4] text-pretty whitespace-pre-wrap text-primary-foreground sm:max-w-[72%]",
          pending && "opacity-60",
        )}
      >
        {message.content}
      </div>
      <p className="text-caption flex items-center gap-2 text-tertiary">
        {pending ? (
          "Sending…"
        ) : (
          <>
            {meta ? (
              <span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-muted-foreground">{meta.label}</span>
            ) : null}
            <RelativeTime iso={message.createdAt} />
          </>
        )}
      </p>
    </div>
  );
}

function WorkerBubble({ message, worker }: { message: ChatMessageView; worker: { name: string; avatarColor: string } }) {
  const proposalOpen = message.href !== null && (message.proposalStatus === null || message.proposalStatus === "PROPOSED");
  const applied = message.proposalStatus === "ACTIVE" || message.proposalStatus === "REPLACED";

  return (
    <div className="flex items-end gap-2.5">
      <WorkerAvatar name={worker.name} color={worker.avatarColor} size="sm" className="mb-7 shrink-0" />
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <div className="max-w-full rounded-[18px] bg-secondary px-4 py-2.5 text-[15px] leading-[1.4] text-foreground">
          <Markdown content={message.content} variant="compact" className="[&_p+p]:mt-2 [&_p]:my-0" />
        </div>

        {message.href ? (
          <div className="w-full max-w-[420px] rounded-[14px] bg-card p-4 shadow-card">
            <p className="text-[15px] font-medium">
              {proposalOpen
                ? `A change to how ${worker.name} works, drafted as version ${message.proposedVersion ?? "—"}`
                : applied
                  ? `Applied as version ${message.proposedVersion ?? "—"}`
                  : "This proposal was declined"}
            </p>
            {message.normalizedInstruction ? (
              <p className="text-footnote mt-1 text-pretty text-muted-foreground">{message.normalizedInstruction}</p>
            ) : null}
            <p className="mt-3">
              <Link href={message.href} className="text-footnote font-medium text-link hover:underline">
                {proposalOpen ? "Compare and decide" : "See what changed"} ›
              </Link>
            </p>
          </div>
        ) : null}

        <p className="text-caption flex items-center gap-2 text-tertiary">
          <span>{worker.name}</span>
          <RelativeTime iso={message.createdAt} />
        </p>
      </div>
    </div>
  );
}

/** The worker's "thinking" line while a reply is being composed — words, not a spinner. */
export function ChatTyping({ worker }: { worker: { name: string; avatarColor: string } }) {
  return (
    <div className="flex items-end gap-2.5" aria-live="polite">
      <WorkerAvatar name={worker.name} color={worker.avatarColor} size="sm" className="shrink-0" />
      <p className="text-footnote rounded-[18px] bg-secondary px-4 py-2.5 text-muted-foreground">
        {worker.name} is thinking…
      </p>
    </div>
  );
}
