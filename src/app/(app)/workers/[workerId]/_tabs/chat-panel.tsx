"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChatMessageView, WorkerChatView } from "@/server/queries/worker-manage";
import { sendMessageAction } from "../manage-actions";
import { ChatMessage, ChatTyping } from "./chat-message";

/** One of each kind, so the first message shows what the worker can do. */
const SUGGESTIONS = [
  "What did you do in your last run?",
  "This time, focus on European companies",
  "From now on, include the lead investor for every round",
] as const;

const MESSAGE_MAX_CHARS = 4_000;

interface PendingSend {
  id: string;
  content: string;
}

export interface ChatPanelProps {
  worker: WorkerChatView["worker"];
  messages: ChatMessageView[];
  pendingInstructions: number;
  /** `workers.chat` — the composer is read-only for roles that can't send. */
  canSend: boolean;
}

export function ChatPanel({ worker, messages, pendingInstructions, canSend: mayChat }: ChatPanelProps) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingSend | null>(null);
  // Messages the server has not rendered yet (a send just finished); dropped once they arrive via props.
  const [extra, setExtra] = useState<ChatMessageView[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const seen = new Set(messages.map((m) => m.id));
    return [...messages, ...extra.filter((m) => !seen.has(m.id))];
  }, [messages, extra]);

  // Keep the newest message in view once a conversation is under way (never on first paint, which would
  // yank the page down past the header).
  const seen = useRef(0);
  useEffect(() => {
    if (seen.current > 0 && all.length + (pending ? 1 : 0) > seen.current) {
      endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    seen.current = all.length + (pending ? 1 : 0);
  }, [all.length, pending]);

  const retired = worker.status === "RETIRED";
  const simulatedReplies = all.some((m) => m.role !== "USER" && m.simulated);
  const composerDisabled = pending !== null || retired || !mayChat;
  const canSubmit = draft.trim().length > 0 && draft.length <= MESSAGE_MAX_CHARS && !composerDisabled;

  async function send(text: string) {
    const content = text.trim();
    if (content.length === 0 || composerDisabled) return;
    const local: PendingSend = { id: `pending-${Date.now()}`, content };
    setPending(local);
    setDraft("");
    const r = await sendMessageAction(worker.id, content);
    setPending(null);
    if (!r.ok) {
      setDraft(content);
      toast.error(r.error);
      return;
    }
    setExtra((prev) => [...prev, ...r.data.messages]);
    if (r.data.classification === "SPEC_CHANGE" && r.data.href) {
      toast.success(`${worker.name} drafted a proposed change`, { description: "Review it before it takes effect." });
    } else if (r.data.classification === "TEMPORARY_INSTRUCTION") {
      toast.success(`${worker.name} will apply this on the next run`);
    }
    router.refresh();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  const empty = all.length === 0 && !pending;

  return (
    <div className="mx-auto w-full max-w-[760px]">
      <div className="flex min-h-[46vh] flex-col justify-end gap-4 pb-4">
        {empty ? (
          <div className="py-10 text-center">
            <h2 className="text-title-2 text-balance">Talk to {worker.name} like a colleague</h2>
            <p className="text-body mx-auto mt-2.5 max-w-[46ch] text-pretty text-muted-foreground">
              Ask what they did, adjust the next run, or change how they work for good. Lasting changes come back
              as a proposal for you to approve.
            </p>
          </div>
        ) : (
          all.map((m) => <ChatMessage key={m.id} message={m} worker={worker} />)
        )}

        {pending ? (
          <>
            <ChatMessage
              message={{
                id: pending.id,
                role: "USER",
                content: pending.content,
                classification: null,
                createdAt: new Date().toISOString(),
                simulated: false,
                proposedVersionId: null,
                proposedVersion: null,
                proposalStatus: null,
                href: null,
                normalizedInstruction: null,
              }}
              worker={worker}
              pending
            />
            <ChatTyping worker={worker} />
          </>
        ) : null}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="material-thick sticky bottom-0 -mx-4 space-y-3 px-4 pt-3 pb-4 shadow-bar sm:-mx-6 sm:px-6"
      >
        {empty && !composerDisabled ? (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setDraft(s);
                  textareaRef.current?.focus();
                }}
                className="text-footnote rounded-full bg-secondary px-3.5 py-1.5 font-medium text-foreground transition-colors duration-200 ease-standard hover:bg-secondary-hover"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={composerDisabled}
            placeholder={
              retired
                ? `${worker.name} has been retired and no longer takes messages.`
                : !mayChat
                  ? "Your role can read this conversation but not send messages."
                  : `Message ${worker.name}…`
            }
            aria-label={`Message ${worker.name}`}
            rows={1}
            maxLength={MESSAGE_MAX_CHARS}
            className={cn("max-h-40 min-h-11 flex-1 resize-none rounded-[22px] py-2.5")}
          />
          <Button type="submit" size="icon" disabled={!canSubmit} aria-label="Send message" className="mb-0.5">
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>

        {/* Said once for the whole conversation, not as a pill on every reply. */}
        <p className="text-caption flex flex-wrap items-center gap-x-2 text-tertiary">
          <span>Enter sends · Shift+Enter adds a line</span>
          {simulatedReplies ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Replies come from the simulator</span>
            </>
          ) : null}
          {pendingInstructions > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {pendingInstructions === 1
                  ? "1 one-off instruction is queued for the next run"
                  : `${pendingInstructions} one-off instructions are queued for the next run`}
              </span>
            </>
          ) : null}
        </p>
      </form>
    </div>
  );
}
