/**
 * @fileoverview Breadcrumb components for hierarchical navigation (compiled).
 * @module ui/breadcrumb
 * @see {@link ./breadcrumb.jsx} for source with full JSDoc documentation.
 */

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Breadcrumb root container.
 * @type {React.ComponentPropsWithoutRef<"nav">}
 * @property {string} [aria-label="breadcrumb"] - Accessible label
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - BreadcrumbList component
 */
const Breadcrumb = React.forwardRef(({ ...props }, ref) => _jsx("nav", { ref: ref, "aria-label": "breadcrumb", ...props }));
Breadcrumb.displayName = "Breadcrumb";

/**
 * Breadcrumb list container.
 * @type {React.ComponentPropsWithoutRef<"ol">}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - BreadcrumbItem components
 */
const BreadcrumbList = React.forwardRef(({ className, ...props }, ref) => (_jsx("ol", { ref: ref, className: cn("flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground sm:gap-2.5", className), ...props })));
BreadcrumbList.displayName = "BreadcrumbList";

/**
 * Breadcrumb list item.
 * @type {React.ComponentPropsWithoutRef<"li">}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - BreadcrumbLink or BreadcrumbPage
 */
const BreadcrumbItem = React.forwardRef(({ className, ...props }, ref) => (_jsx("li", { ref: ref, className: cn("inline-flex items-center gap-1.5", className), ...props })));
BreadcrumbItem.displayName = "BreadcrumbItem";

/**
 * Props for BreadcrumbLink component.
 * @typedef {React.ComponentPropsWithoutRef<"a"> & { asChild?: boolean }} BreadcrumbLinkProps
 * @property {boolean} [asChild] - Merge props onto child instead of rendering <a>
 */

/**
 * Breadcrumb navigation link.
 * @type {BreadcrumbLinkProps}
 * @property {boolean} [asChild] - Merge props onto child element
 * @property {string} [href] - Link destination
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Link text content
 */
const BreadcrumbLink = React.forwardRef(({ asChild, className, ...props }, ref) => {
    const Comp = asChild ? Slot : "a";
    return ((_jsx(Comp, { ref: ref, className: cn("transition-colors hover:text-foreground", className), ...props })));
});
BreadcrumbLink.displayName = "BreadcrumbLink";

/**
 * Current page indicator.
 * @type {React.ComponentPropsWithoutRef<"span">}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Page name
 */
const BreadcrumbPage = React.forwardRef(({ className, ...props }, ref) => (_jsx("span", { ref: ref, role: "link", "aria-disabled": "true", "aria-current": "page", className: cn("font-normal text-foreground", className), ...props })));
BreadcrumbPage.displayName = "BreadcrumbPage";

/**
 * Breadcrumb separator.
 * @type {React.ComponentPropsWithoutRef<"li"> & { children?: React.ReactNode }}
 * @property {React.ReactNode} [children] - Custom separator content (default: ChevronRight)
 * @property {string} [className] - Additional CSS classes
 */
const BreadcrumbSeparator = ({ children, className, ...props }) => (_jsx("li", { role: "presentation", "aria-hidden": "true", className: cn("[&>svg]:w-3.5 [&>svg]:h-3.5", className), ...props, children: children ?? _jsx(ChevronRight, {}) }));
BreadcrumbSeparator.displayName = "BreadcrumbSeparator";

/**
 * Breadcrumb ellipsis indicator.
 * @type {React.HTMLAttributes<HTMLSpanElement>}
 * @property {string} [className] - Additional CSS classes
 */
const BreadcrumbEllipsis = ({ className, ...props }) => (_jsxs("span", { role: "presentation", "aria-hidden": "true", className: cn("flex h-9 w-9 items-center justify-center", className), ...props, children: [_jsx(MoreHorizontal, { className: "h-4 w-4" }), _jsx("span", { className: "sr-only", children: "More" })] }));
BreadcrumbEllipsis.displayName = "BreadcrumbElipssis";

export { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, BreadcrumbEllipsis, };
