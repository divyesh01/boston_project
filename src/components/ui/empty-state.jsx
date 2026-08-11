/**
 * @fileoverview Empty state component for displaying no-data scenarios.
 * 
 * Provides a consistent UI for empty data states with customizable
 * icon, title, description, and action button.
 * 
 * @module ui/empty-state
 * @example
 * ```jsx
 * import EmptyState from "@/components/ui/empty-state";
 * 
 * <EmptyState
 *   icon={<InboxIcon className="h-12 w-12" />}
 *   title="No transactions found"
 *   description="Try adjusting your filters or import new data."
 *   action={<Button onClick={handleImport}>Import Data</Button>}
 * />
 * ```
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * @typedef {Object} EmptyStateProps
 * @property {React.ReactNode} [icon] - Icon to display above title
 * @property {string} title - Main title text
 * @property {string} [description] - Secondary description text
 * @property {React.ReactNode} [action] - Action button or element
 * @property {string} [className] - Additional CSS classes
 */

/**
 * Empty state component.
 * 
 * Displays a centered empty state with icon, title, optional description,
 * and optional action. Used throughout the app when no data is available.
 * 
 * @type {React.FC<EmptyStateProps>}
 * @property {React.ReactNode} [icon] - Icon element (typically 48-64px)
 * @property {string} title - Primary message (e.g., "No results found")
 * @property {string} [description] - Secondary explanatory text
 * @property {React.ReactNode} [action] - CTA button or link
 * @property {string} [className] - Additional CSS classes
 */
const EmptyState = ({
  icon,
  title,
  description,
  action,
  className,
}) => {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-12 px-4 text-center",
        className
      )}
      role="status"
      aria-live="polite"
    >
      {icon && (
        <div className="mb-4 text-muted-foreground/50">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-foreground">
        {title}
      </h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && (
        <div className="mt-6">
          {action}
        </div>
      )}
    </div>
  );
};

EmptyState.displayName = "EmptyState";

export default EmptyState;
