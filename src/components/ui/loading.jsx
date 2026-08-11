/**
 * @fileoverview Loading indicator component with multiple display modes.
 * 
 * Provides consistent loading states across the application with support
 * for inline spinners, full-page overlays, and skeleton placeholders.
 * 
 * @module ui/loading
 * @example
 * ```jsx
 * import Loading from "@/components/ui/loading";
 * 
 * // Inline spinner
 * <Loading size="md" text="Loading data..." />
 * 
 * // Full page overlay
 * <Loading fullPage text="Initializing..." />
 * ```
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * @typedef {Object} LoadingProps
 * @property {'sm' | 'md' | 'lg'} [size='md'] - Spinner size
 * @property {string} [text] - Loading text to display below spinner
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [fullPage] - Whether to display as full-page overlay
 * @property {boolean} [centered] - Whether to center in container
 */

/**
 * Loading indicator component.
 * 
 * Displays an animated spinner with optional text. Can render as an
 * inline element or a full-page overlay for initial app loading.
 * 
 * @type {React.FC<LoadingProps>}
 * @property {'sm' | 'md' | 'lg'} [size='md'] - Spinner size preset
 * @property {string} [text] - Text displayed below the spinner
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [fullPage] - Full-page overlay mode
 * @property {boolean} [centered] - Center within parent container
 */
const Loading = ({
  size = "md",
  text,
  className,
  fullPage = false,
  centered = true,
}) => {
  const sizeClasses = {
    sm: "h-4 w-4 border-2",
    md: "h-8 w-8 border-3",
    lg: "h-12 w-12 border-4",
  };

  const spinner = (
    <div
      className={cn(
        "animate-spin rounded-full border-primary border-t-transparent",
        sizeClasses[size],
        className
      )}
      role="status"
      aria-label={text || "Loading"}
    >
      <span className="sr-only">{text || "Loading..."}</span>
    </div>
  );

  if (fullPage) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm"
        role="alert"
        aria-busy="true"
      >
        {spinner}
        {text && (
          <p className="mt-4 text-sm text-muted-foreground">{text}</p>
        )}
      </div>
    );
  }

  if (centered) {
    return (
      <div
        className="flex flex-col items-center justify-center py-8"
        role="alert"
        aria-busy="true"
      >
        {spinner}
        {text && (
          <p className="mt-3 text-sm text-muted-foreground">{text}</p>
        )}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2" role="status">
      {spinner}
      {text && <span className="text-sm text-muted-foreground">{text}</span>}
    </div>
  );
};

Loading.displayName = "Loading";

export default Loading;
