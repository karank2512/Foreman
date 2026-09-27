"use client";

import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type NativeProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "id" | "name" | "type" | "className" | "placeholder"
>;

export interface AuthFieldProps extends NativeProps {
  id?: string;
  name: string;
  label: string;
  type?: "text" | "email" | "password";
  value: string;
  onValueChange: (value: string) => void;
  /** Field-level message under the input; also turns the border red. */
  error?: string | null;
  /** Mark the field red without a message of its own — the form's inline alert already says what is wrong. */
  invalid?: boolean;
  /** Quiet guidance under the input, shown when there is no error. */
  hint?: ReactNode;
  /** Rendered inside the field on the right — the password "Show" toggle. */
  trailing?: ReactNode;
  /** Extra ids for `aria-describedby` (the password checklist). */
  describedBy?: string;
}

/**
 * The auth pages' one input: 56px tall, with the label sitting inside the field and rising out of the way
 * once there is something to read. Because the value is controlled we decide "raised" in JS rather than with
 * stacked `:placeholder-shown` / `:focus` variants, whose CSS order is not guaranteed.
 */
export function AuthField({
  id,
  name,
  label,
  type = "text",
  value,
  onValueChange,
  error,
  invalid = false,
  hint,
  trailing,
  describedBy,
  ...props
}: AuthFieldProps) {
  const generated = useId();
  const fieldId = id ?? `${name}-${generated}`;
  const messageId = `${fieldId}-message`;
  const [focused, setFocused] = useState(false);
  const raised = focused || value.length > 0;
  const isInvalid = Boolean(error) || invalid;
  const described = [error || hint ? messageId : null, describedBy].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col">
      <div className="relative">
        <input
          {...props}
          id={fieldId}
          name={name}
          type={type}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-invalid={isInvalid ? true : undefined}
          aria-describedby={described}
          className={cn(
            "h-14 w-full rounded-lg border bg-background px-3.5 pt-6 pb-1.5 text-[17px] leading-6 tracking-[-0.022em] transition-[border-color,box-shadow] duration-200 ease-standard outline-none",
            "focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/15",
            "read-only:text-muted-foreground disabled:bg-muted disabled:text-tertiary",
            isInvalid ? "border-danger" : "border-input",
            trailing && "pr-20",
          )}
        />
        <label
          htmlFor={fieldId}
          className={cn(
            "pointer-events-none absolute left-3.5 origin-left text-muted-foreground transition-[top,font-size,line-height] duration-[180ms] ease-standard",
            raised ? "top-2 text-[12px] leading-4" : "top-1/2 -mt-3 text-[17px] leading-6",
          )}
        >
          {label}
        </label>
        {trailing ? <div className="absolute inset-y-0 right-2.5 flex items-center">{trailing}</div> : null}
      </div>

      {error || hint ? (
        <p
          id={messageId}
          className={cn("mt-1.5 px-1 text-[13px] leading-[18px]", error ? "text-danger" : "text-muted-foreground")}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

/** A value the visitor cannot change (the email an invitation is addressed to) — shown, never submitted. */
export function AuthStaticField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-14 flex-col justify-center rounded-lg bg-muted px-3.5">
      <span className="text-[12px] leading-4 text-muted-foreground">{label}</span>
      <span className="truncate text-[17px] leading-6 tracking-[-0.022em]">{value}</span>
    </div>
  );
}

/** The in-field "Show" / "Hide" text toggle; a word beats an eye icon here. 44px square inside the 56px field. */
export function ShowToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      className="inline-flex h-11 min-w-11 items-center justify-center rounded-full px-2 text-[13px] font-medium text-link outline-none hover:underline"
    >
      {shown ? "Hide" : "Show"}
      <span className="sr-only"> password</span>
    </button>
  );
}
