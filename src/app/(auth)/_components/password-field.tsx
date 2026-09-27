"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FIELD_LIMITS, passwordChecklist, type PasswordCheck, type PasswordCheckContext } from "../schema";
import { AuthField, ShowToggle } from "./field";

interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  minLength: number;
  /** The account's own details, so the checklist can warn about echoing them back. */
  context: PasswordCheckContext;
  readOnly?: boolean;
  label?: string;
  id?: string;
}

/**
 * How each secondary rule reads when it is the thing standing in the way. The checklist in `../schema` names
 * the rules in implementation terms (bytes, distinct characters); a person typing a password gets a sentence.
 */
const PROBLEM_COPY: Record<string, string> = {
  bytes: "That's too long for us to store safely. Try something shorter.",
  variety: "Use a few more different characters.",
  echo: "Leave out your name, email and workspace name.",
};

/**
 * Password input with one live requirement line, "At least N characters", which turns green with a check
 * once met. The other rules are not listed up front: each appears as a plain sentence only while it is the
 * one thing blocking an otherwise long-enough password. The list is guidance only — `@/server/account`
 * re-checks every rule and additionally refuses breached passwords, keyboard runs and counting sequences,
 * and its refusal comes back as the form's inline error.
 */
export function PasswordField({
  value,
  onChange,
  minLength,
  context,
  readOnly = false,
  label = "Password",
  id = "password",
}: PasswordFieldProps) {
  const [show, setShow] = useState(false);
  const checks = passwordChecklist(value, minLength, context);
  const length = checks.find((check) => check.id === "length");
  const problems = length?.ok ? checks.filter((check) => check.id !== "length" && !check.ok) : [];

  return (
    <div>
      <AuthField
        id={id}
        name="password"
        label={label}
        type={show ? "text" : "password"}
        value={value}
        onValueChange={onChange}
        autoComplete="new-password"
        required
        maxLength={FIELD_LIMITS.password}
        readOnly={readOnly}
        describedBy={`${id}-checklist`}
        trailing={<ShowToggle shown={show} onToggle={() => setShow((v) => !v)} />}
      />

      <ul id={`${id}-checklist`} className="mt-3 flex flex-col gap-1.5">
        {length ? <ChecklistLine ok={length.ok}>{length.label}</ChecklistLine> : null}
        {problems.map((problem) => (
          <ChecklistLine key={problem.id} ok={false} problem>
            {PROBLEM_COPY[problem.id] ?? problem.label}
          </ChecklistLine>
        ))}
      </ul>
    </div>
  );
}

function ChecklistLine({
  ok,
  problem = false,
  children,
}: {
  ok: PasswordCheck["ok"];
  /** A sentence about what is wrong, rather than a requirement that can be met. */
  problem?: boolean;
  children: string;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-2 text-[13px] leading-[18px] transition-colors duration-200 ease-standard",
        ok ? "text-success" : "text-muted-foreground",
      )}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center" aria-hidden>
        {ok ? <Check className="size-3.5" /> : <span className="size-[5px] rounded-full bg-current opacity-45" />}
      </span>
      <span>{children}</span>
      {problem ? null : <span className="sr-only">{ok ? " — met" : " — not met yet"}</span>}
    </li>
  );
}
