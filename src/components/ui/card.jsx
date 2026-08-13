/**
 * @fileoverview Card components for content containers.
 * 
 * Provides a flexible card system with header, content, footer,
 * title, and description sections. Used throughout dashboards
 * and detail views for consistent content grouping.
 * 
 * @module ui/card
 * @example
 * ```jsx
 * import {
 *   Card,
 *  CardHeader,
 *   CardTitle,
 *   CardDescription,
 *   CardContent,
 *   CardFooter,
 * } from "@/components/ui/card";
 * 
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Revenue Overview</CardTitle>
 *     <CardDescription>Monthly revenue breakdown</CardDescription>
 *   </CardHeader>
 *   <CardContent>
 *     <Chart data={revenueData} />
 *   </CardContent>
 *   <CardFooter>
 *     <Button>View Details</Button>
 *   </CardFooter>
 * </Card>
 * ```
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Card root container.
 * 
 * Rounded container with border, background, and shadow.
 * Used as the wrapper for all card sections.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CardHeader, CardContent, CardFooter
 */
const Card = React.forwardRef(
  ({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("rounded-xl border bg-card text-card-foreground shadow", className)}
    {...props} />
))
Card.displayName = "Card"

/**
 * Card header section.
 * 
 * Top section of the card for title and description.
 * Uses flexbox column layout with consistent spacing.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CardTitle, CardDescription
 */
const CardHeader = React.forwardRef(
  ({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props} />
))
CardHeader.displayName = "CardHeader"

/**
 * Card title heading.
 * 
 * Bold, tight-tracking heading for the card. Renders as a div
 * (can be changed to h1-h6 via asChild or className).
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Title text
 */
const CardTitle = React.forwardRef(
  ({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("font-semibold leading-none tracking-tight", className)}
    {...props} />
))
CardTitle.displayName = "CardTitle"

/**
 * Card description text.
 * 
 * Secondary text in muted color below the title.
 * Provides context for the card content.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Description text
 */
const CardDescription = React.forwardRef(
  ({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props} />
))
CardDescription.displayName = "CardDescription"

/**
 * Card main content area.
 * 
 * Primary content section with padding. Removes top padding
 * when following a CardHeader for seamless spacing.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Main content
 */
const CardContent = React.forwardRef(
  ({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

/**
 * Card footer section.
 * 
 * Bottom section for actions and metadata.
 * Uses flexbox with centered items and responsive spacing.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Action buttons or metadata
 */
const CardFooter = React.forwardRef(
  ({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props} />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
