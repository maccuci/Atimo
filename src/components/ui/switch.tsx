import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/*
 * shadcn Switch, restyled for Atimo tokens.
 *
 * Checked state uses cyan (selection / status), unchecked stays in the
 * monochrome border ladder — no purple primary, no decorative hue.
 */

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitives.Root>) {
  return (
    <SwitchPrimitives.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-transparent",
        "transition-[background-color,border-color,box-shadow] duration-150 ease-[var(--ease-out)]",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-cyan/30",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-cyan data-[state=checked]:border-cyan",
        "data-[state=unchecked]:bg-bg-active data-[state=unchecked]:border-border-strong",
        className,
      )}
      {...props}
    >
      <SwitchPrimitives.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-[16px] rounded-full shadow-sm",
          "transition-transform duration-150 ease-[var(--ease-out)]",
          "data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[2px]",
          "data-[state=checked]:bg-bg data-[state=unchecked]:bg-fg-dim",
        )}
      />
    </SwitchPrimitives.Root>
  );
}

export { Switch };
