/**
 * @fileoverview Avatar components for displaying user images with fallback.
 * 
 * Built on Radix UI Avatar primitive for accessible user profile images.
 * Supports image loading states with automatic fallback to initials
 * or custom placeholder when the image fails to load.
 * 
 * @module ui/avatar
 * @example
 * ```jsx
 * import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
 * 
 * <Avatar>
 *   <AvatarImage src="/profile.jpg" alt="John Doe" />
 *   <AvatarFallback>JD</AvatarFallback>
 * </Avatar>
 * ```
 */

"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"

/**
 * Avatar root container.
 * 
 * Renders as a circular container (10x10 by default) with hidden overflow.
 * Manages loading state for the image child and triggers fallback
 * display when the image fails to load or is still loading.
 * 
 * @type {React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>}
 * @property {'default' | 'loading'} [delayDuration] - Delay before showing fallback (ms)
 * @property {string} [className] - Additional CSS classes for sizing/shape
 * 
 * @example
 * <Avatar className="h-12 w-12">
 *   <AvatarImage src={user.avatar} alt={user.name} />
 *   <AvatarFallback className="bg-primary text-white">
 *     {user.name.charAt(0)}
 *   </AvatarFallback>
 * </Avatar>
 */
const Avatar = React.forwardRef(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)}
    {...props} />
))
Avatar.displayName = AvatarPrimitive.Root.displayName

/**
 * Avatar image element.
 * 
 * Renders the profile image inside the Avatar container. Automatically
 * handles loading events to communicate with the parent Avatar component.
 * If the image fails to load, the AvatarFallback is displayed instead.
 * 
 * @type {React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>}
 * @property {string} src - Image URL (required)
 * @property {string} [alt] - Alt text for accessibility
 * @property {string} [className] - Additional CSS classes
 * 
 * @example
 * <AvatarImage
 *   src="https://example.com/avatar.jpg"
 *   alt="User profile photo"
 *   className="border-2 border-white"
 * />
 */
const AvatarImage = React.forwardRef(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full", className)}
    {...props} />
))
AvatarImage.displayName = AvatarPrimitive.Image.displayName

/**
 * Avatar fallback content.
 * 
 * Displayed when the AvatarImage fails to load or is still loading.
 * Typically contains user initials or an icon. Styled as a centered,
 * muted-background container that fills the Avatar dimensions.
 * 
 * @type {React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>}
 * @property {number} [delayDuration] - Delay in ms before showing fallback
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Fallback content (initials, icon, etc.)
 * 
 * @example
 * <AvatarFallback delayDuration={600}>JD</AvatarFallback>
 * 
 * @example
 * <AvatarFallback className="bg-red-500">
 *   <UserIcon className="h-5 w-5 text-white" />
 * </AvatarFallback>
 */
const AvatarFallback = React.forwardRef(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-muted",
      className
    )}
    {...props} />
))
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

export { Avatar, AvatarImage, AvatarFallback }
