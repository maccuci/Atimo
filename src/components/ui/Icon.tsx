import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "@/lib/utils";

type IconProps = {
  icon: IconSvgElement;
  size?: number;
  strokeWidth?: number;
  className?: string;
  color?: string;
};

/** Thin wrapper so call sites stay consistent with Hugeicons stroke defaults. */
export function Icon({
  icon,
  size = 16,
  strokeWidth = 1.75,
  className,
  color = "currentColor",
}: IconProps) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
      color={color}
      className={cn("shrink-0", className)}
    />
  );
}
