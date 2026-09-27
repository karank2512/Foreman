import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/**
 * Pills. One `default` (blue) button per view; `secondary` gray pills for everything else; `link` — blue text,
 * optionally with a trailing chevron via `data-icon="inline-end"` — for tertiary actions. No shadows, no lift.
 *
 * Touch: under `md` every size below 44px grows an invisible `::before` hit area (vertical for pills and text
 * links, all round for icon buttons) so the drawn pill keeps its size while the tap box meets the 44px minimum.
 * That is why the base is `relative`.
 */
const HIT_AREA = "max-md:before:absolute max-md:before:inset-x-0"

const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding font-medium tracking-[-0.01em] whitespace-nowrap transition-[background-color,box-shadow,opacity,color] duration-200 ease-standard outline-none select-none focus-visible:ring-4 focus-visible:ring-primary/30 active:opacity-90 disabled:pointer-events-none disabled:opacity-40 aria-invalid:ring-4 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover aria-expanded:bg-secondary-hover",
        outline:
          "border-input bg-background text-foreground hover:bg-muted aria-expanded:bg-muted",
        ghost: "text-foreground hover:bg-black/5 aria-expanded:bg-black/5",
        destructive: "bg-danger-soft text-danger hover:bg-danger/15 focus-visible:ring-danger/25",
        link: "h-auto rounded-sm p-0 text-link hover:underline hover:underline-offset-4 active:opacity-70",
      },
      size: {
        xs: `h-6 gap-1 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3 ${HIT_AREA} max-md:before:-inset-y-2.5`,
        sm: `h-7 gap-1.5 px-3.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5 ${HIT_AREA} max-md:before:-inset-y-2`,
        default: `h-9 gap-1.5 px-4 text-sm ${HIT_AREA} max-md:before:-inset-y-1`,
        lg: "h-11 gap-2 px-5.5 text-[17px]",
        xl: "h-12 gap-2 px-7 text-[17px]",
        icon: "size-8 max-md:before:absolute max-md:before:-inset-1.5",
        "icon-xs": "size-6 max-md:before:absolute max-md:before:-inset-2.5 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 max-md:before:absolute max-md:before:-inset-2 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9 max-md:before:absolute max-md:before:-inset-1",
      },
    },
    compoundVariants: [
      // A text link has no box, so the size variants' height and padding must not apply to it — and its hit area
      // is sized for a ~20px line rather than the pill height the size variant assumed.
      {
        variant: "link",
        size: ["xs", "sm", "default", "lg", "xl"],
        className: `h-auto px-0 ${HIT_AREA} max-md:before:-inset-y-3.5`,
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
