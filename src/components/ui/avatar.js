/**
 * @fileoverview Avatar components for displaying user images with fallback (compiled).
 * @module ui/avatar
 * @see {@link ./avatar.jsx} for source with full JSDoc documentation.
 */

"use client";

import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

/**
 * Avatar root container.
 * @type {React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>}
 * @property {number} [delayDuration] - Delay before showing fallback (ms)
 * @property {string} [className] - Additional CSS classes for sizing/shape
 */
const Avatar = React.forwardRef(({ className, ...props }, ref) => (_jsx(AvatarPrimitive.Root, { ref: ref, className: cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className), ...props })));
Avatar.displayName = AvatarPrimitive.Root.displayName;

/**
 * Avatar image element with automatic loading state handling.
 * @type {React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>}
 * @property {string} src - Image URL (required)
 * @property {string} [alt] - Alt text for accessibility
 * @property {string} [className] - Additional CSS classes
 */
const AvatarImage = React.forwardRef(({ className, ...props }, ref) => (_jsx(AvatarPrimitive.Image, { ref: ref, className: cn("aspect-square h-full w-full", className), ...props })));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

/**
 * Avatar fallback content displayed on image load failure.
 * @type {React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>}
 * @property {number} [delayDuration] - Delay in ms before showing fallback
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Fallback content (initials, icon)
 */
const AvatarFallback = React.forwardRef(({ className, ...props }, ref) => (_jsx(AvatarPrimitive.Fallback, { ref: ref, className: cn("flex h-full w-full items-center justify-center rounded-full bg-muted", className), ...props })));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
