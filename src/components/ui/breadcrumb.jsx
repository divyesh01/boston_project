/**
 * @fileoverview Breadcrumb components for hierarchical navigation.
 *
 * Provides accessible breadcrumb navigation following WAI-ARIA patterns.
 * Supports custom separators, ellipsis truncation, and asChild pattern
 * for integrating with router links (e.g., react-router-dom).
 *
 * @module ui/breadcrumb
 * @example
 * ```jsx
 * import {
 *   Breadcrumb,
 *   BreadcrumbList,
 *   BreadcrumbItem,
 *   BreadcrumbLink,
 *   BreadcrumbSeparator,
 *   BreadcrumbEllipsis,
 * } from "@/components/ui/breadcrumb";
 *
 * <Breadcrumb>
 *   <BreadcrumbList>
 *     <BreadcrumbItem>
 *       <BreadcrumbLink href="/">Home</BreadcrumbLink>
 *     </BreadcrumbItem>
 *     <BreadcrumbSeparator />
 *     <BreadcrumbItem>
 *       <BreadcrumbLink href="/settings">Settings</BreadcrumbLink>
 *     </BreadcrumbItem>
 *     <BreadcrumbSeparator />
 *     <BreadcrumbItem>
 *       <BreadcrumbPage>Profile</BreadcrumbPage>
 *     </BreadcrumbItem>
 *   </BreadcrumbList>
 * </Breadcrumb>
 * ```
 */

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { ChevronRight, MoreHorizontal } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Breadcrumb root container.
 *
 * Renders as a semantic `<nav>` element with appropriate aria-label.
 * Wraps the ordered list of breadcrumb items.
 *
 * @type {React.ComponentPropsWithoutRef<"nav">}
 * @property {string} [aria-label="breadcrumb"] - Accessible label
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - BreadcrumbList component
 *
 * @example
 * <Breadcrumb aria-label="Page navigation">
 *   <BreadcrumbList>{items}</BreadcrumbList>
 * </Breadcrumb>
 */
const Breadcrumb = React.forwardRef(
  ({ ...props }, ref) => <nav ref={ref} aria-label="breadcrumb" {...props} />
)
Breadcrumb.displayName = "Breadcrumb"

/**
 * Breadcrumb list container.
 *
 * Renders as an ordered list (`<ol>`) with flex layout and wrapped items.
 * Applies muted text color and consistent gap spacing.
 *
 * @type {React.ComponentPropsWithoutRef<"ol">}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - BreadcrumbItem components
 */
const BreadcrumbList = React.forwardRef(({ className, ...props }, ref) => (
  <ol
    ref={ref}
    className={cn(
      "flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground sm:gap-2.5",
      className
    )}
    {...props} />
))
BreadcrumbList.displayName = "BreadcrumbList"

/**
 * Breadcrumb list item.
 *
 * Renders as an inline-flex list item for horizontal breadcrumb layouts.
 *
 * @type {React.ComponentPropsWithoutRef<"li">}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - BreadcrumbLink or BreadcrumbPage
 */
const BreadcrumbItem = React.forwardRef(({ className, ...props }, ref) => (
  <li
    ref={ref}
    className={cn("inline-flex items-center gap-1.5", className)}
    {...props} />
))
BreadcrumbItem.displayName = "BreadcrumbItem"

/**
 * Props for BreadcrumbLink component.
 *
 * Extends standard anchor props with Radix UI asChild pattern
 * for merging onto router Link components.
 *
 * @typedef {React.ComponentPropsWithoutRef<"a"> & { asChild?: boolean }} BreadcrumbLinkProps
 * @property {boolean} [asChild] - Merge props onto child instead of rendering <a>
 */

/**
 * Breadcrumb navigation link.
 *
 * Renders as an anchor tag by default, or merges onto its child
 * when `asChild` is true (useful for React Router Link integration).
 * Applies hover color transition styling.
 *
 * @type {BreadcrumbLinkProps}
 * @property {boolean} [asChild] - Merge props onto child element
 * @property {string} [href] - Link destination
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Link text content
 *
 * @example
 * <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
 *
 * @example
 * <BreadcrumbLink asChild>
 *   <Link to="/settings">Settings</Link>
 * </BreadcrumbLink>
 */
const BreadcrumbLink = React.forwardRef(({ asChild, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "a"

  return (
    (<Comp
      ref={ref}
      className={cn("transition-colors hover:text-foreground", className)}
      {...props} />)
  );
})
BreadcrumbLink.displayName = "BreadcrumbLink"

/**
 * Current page indicator.
 *
 * Renders as a non-interactive span with appropriate ARIA attributes
 * indicating it represents the current page.
 *
 * @type {React.ComponentPropsWithoutRef<"span">}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Page name
 */
const BreadcrumbPage = React.forwardRef(({ className, ...props }, ref) => (
  <span
    ref={ref}
    role="link"
    aria-disabled="true"
    aria-current="page"
    className={cn("font-normal text-foreground", className)}
    {...props} />
))
BreadcrumbPage.displayName = "BreadcrumbPage"

/**
 * Breadcrumb separator.
 *
 * Visual divider between breadcrumb items. Defaults to a chevron-right icon.
 * Hidden from screen readers (aria-hidden) as it is purely decorative.
 *
 * @type {React.ComponentPropsWithoutRef<"li"> & { children?: React.ReactNode }}
 * @property {React.ReactNode} [children] - Custom separator content (default: ChevronRight)
 * @property {string} [className] - Additional CSS classes
 *
 * @example
 * <BreadcrumbSeparator />
 *
 * @example
 * <BreadcrumbSeparator>
 *   <SlashIcon className="h-4 w-4" />
 * </BreadcrumbSeparator>
 */
const BreadcrumbSeparator = ({
  children,
  className,
  ...props
}) => (
  <li
    role="presentation"
    aria-hidden="true"
    className={cn("[&>svg]:w-3.5 [&>svg]:h-3.5", className)}
    {...props}>
    {children ?? <ChevronRight />}
  </li>
)
BreadcrumbSeparator.displayName = "BreadcrumbSeparator"

/**
 * Breadcrumb ellipsis indicator.
 *
 * Used to indicate truncated breadcrumb items. Renders as a small
 * square button with a horizontal dots icon. Hidden from screen readers.
 *
 * @type {React.HTMLAttributes<HTMLSpanElement>}
 * @property {string} [className] - Additional CSS classes
 *
 * @example
 * <BreadcrumbEllipsis className="h-8 w-8" />
 */
const BreadcrumbEllipsis = ({
  className,
  ...props
}) => (
  <span
    role="presentation"
    aria-hidden="true"
    className={cn("flex h-9 w-9 items-center justify-center", className)}
    {...props}>
    <MoreHorizontal className="h-4 w-4" />
    <span className="sr-only">More</span>
  </span>
)
BreadcrumbEllipsis.displayName = "BreadcrumbEllipsis"

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
}
