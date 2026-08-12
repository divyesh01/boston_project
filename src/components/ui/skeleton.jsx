/**
 * @fileoverview Skeleton component for loading placeholder content.
 * Renders an animated pulse placeholder div.
 * @module skeleton
 */
import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}) {
  return (
    (<div
      className={cn("animate-pulse rounded-md bg-primary/10", className)}
      {...props} />)
  );
}

export { Skeleton }
