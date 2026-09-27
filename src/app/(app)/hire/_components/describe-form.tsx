"use client";

import { useId, useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { scopeJobAction } from "../actions";
import { DESCRIPTION_MAX_CHARS, DESCRIPTION_MIN_CHARS, DESCRIPTION_PLACEHOLDER, EXAMPLE_JOBS, submitShortcutLabel } from "../schema";
import { InlineError, StepBar } from "./step-bar";

/** The platform never changes while the page is open, so there is nothing to subscribe to. */
const subscribeNever = () => () => {};

function platformShortcut(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return submitShortcutLabel(nav.userAgentData?.platform || nav.platform);
}

/**
 * `null` on the server and during hydration — the server cannot know the keyboard, and guessing would either
 * mismatch or show Mac users "Ctrl" — then the real modifier once the client has rendered.
 */
function useSubmitShortcut(): string | null {
  return useSyncExternalStore(subscribeNever, platformShortcut, () => null);
}

/**
 * Step 1 — Describe. One big, quiet writing surface: no visible field chrome, 19px text, and three examples
 * offered underneath as suggestions. "Continue" creates the DRAFT job and puts `?jobId=` in the URL, from
 * which point the server owns the step.
 */
export function DescribeForm({ initialText = "" }: { initialText?: string }) {
  const router = useRouter();
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shortcut = useSubmitShortcut();

  const length = text.trim().length;
  const tooShort = length < DESCRIPTION_MIN_CHARS;
  const tooLong = length > DESCRIPTION_MAX_CHARS;
  const canSubmit = !tooShort && !tooLong && !pending;
  const activeExample = EXAMPLE_JOBS.find((job) => job.description === text)?.id ?? null;

  function applyExample(description: string) {
    setText(description);
    setError(null);
    textareaRef.current?.focus();
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const result = await scopeJobAction(text);
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      const n = result.data.questionCount;
      toast.success(n > 0 ? `Got it. ${n} quick question${n === 1 ? "" : "s"} before we draft the spec.` : "Got it. Let's draft the job spec.");
      router.replace(result.data.redirectTo);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
  }

  return (
    <form onSubmit={submit} aria-busy={pending} className="space-y-8">
      <Card className="[--card-spacing:--spacing(7)] max-sm:[--card-spacing:--spacing(5)]">
        <CardContent className="space-y-3">
          <label htmlFor={textareaId} className="sr-only">
            Describe the job
          </label>
          <Textarea
            id={textareaId}
            ref={textareaRef}
            name="description"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={onKeyDown}
            placeholder={DESCRIPTION_PLACEHOLDER}
            disabled={pending}
            aria-invalid={error !== null || tooLong ? true : undefined}
            aria-describedby={`${textareaId}-hint`}
            className="min-h-50 resize-none rounded-none border-0 bg-transparent p-0 text-[19px] leading-[1.5] tracking-[-0.01em] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent sm:text-[19px]"
            autoFocus
          />
          <p id={`${textareaId}-hint`} className={cn("text-right text-footnote text-muted-foreground", tooLong && "text-danger")}>
            {length > 0 ? (
              <span className="metric">
                {length.toLocaleString("en-US")} / {DESCRIPTION_MAX_CHARS.toLocaleString("en-US")}
              </span>
            ) : (
              <span className="sr-only">The outcome, how often, and who it is for.</span>
            )}
          </p>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <p className="text-footnote text-muted-foreground">Try an example</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_JOBS.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => applyExample(job.description)}
              disabled={pending}
              aria-pressed={activeExample === job.id}
              className={cn(
                "relative inline-flex h-9 items-center rounded-full px-4 text-callout font-medium transition-[background-color,color] duration-200 ease-standard",
                // Under `md` a 44px tap band around the 36px pill; with the 8px row gap, bands of stacked rows just meet.
                "max-md:before:absolute max-md:before:inset-x-0 max-md:before:top-[calc(50%_-_22px)] max-md:before:h-11",
                "outline-none focus-visible:ring-4 focus-visible:ring-primary/30 disabled:opacity-40",
                activeExample === job.id
                  ? "bg-foreground text-background"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary-hover",
              )}
            >
              {job.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <InlineError>{error}</InlineError> : null}

      <StepBar
        note={
          <span className="max-sm:hidden">
            Scoping takes a few seconds.{shortcut ? ` ${shortcut} also works.` : null}
          </span>
        }
      >
        <Button type="submit" size="lg" disabled={!canSubmit} className="max-sm:w-full">
          {pending ? "Scoping the job…" : "Continue"}
        </Button>
      </StepBar>
    </form>
  );
}
