/**
 * @fileoverview Table components for data display.
 * 
 * Semantic table components with consistent styling for headers,
 * bodies, rows, and cells. Used throughout the app for data
 * grids, lists, and comparison views.
 * 
 * @module ui/table
 * @example
 * ```jsx
 * import {
 *   Table,
 *   TableHeader,
 *   TableBody,
 *   TableRow,
 *   TableHead,
 *   TableCell,
 * } from "@/components/ui/table";
 * 
 * <Table>
 *   <TableHeader>
 *     <TableRow>
 *       <TableHead>Name</TableHead>
 *       <TableHead>Amount</TableHead>
 *     </TableRow>
 *   </TableHeader>
 *   <TableBody>
 *     {items.map((item) => (
 *       <TableRow key={item.id}>
 *         <TableCell>{item.name}</TableCell>
 *         <TableCell>{item.amount}</TableCell>
 *       </TableRow>
 *     ))}
 *   </TableBody>
 * </Table>
 * ```
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Table wrapper with scrollable container.
 * 
 * Wraps the table element in a scrollable div for horizontal
 * overflow handling. Required for responsive table layouts.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - TableHeader, TableBody, TableFooter
 */
const Table = React.forwardRef(
  ({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-sm", className)}
      {...props} />
  </div>
))
Table.displayName = "Table"

/**
 * Table header section.
 * 
 * Contains column header rows. Bottom border applied to rows
 * for visual separation from body content.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - TableRow elements with TableHead cells
 */
const TableHeader = React.forwardRef(
  ({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
))
TableHeader.displayName = "TableHeader"

/**
 * Table body section.
 * 
 * Contains data rows. Removes bottom border from last row
 * for clean visual termination.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - TableRow elements
 */
const TableBody = React.forwardRef(
  ({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props} />
))
TableBody.displayName = "TableBody"

/**
 * Table footer section.
 * 
 * Contains summary rows with muted background. Used for
 * totals, averages, or aggregated data.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - TableRow elements
 */
const TableFooter = React.forwardRef(
  ({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
    {...props} />
))
TableFooter.displayName = "TableFooter"

/**
 * Table row element.
 * 
 * Row with hover effect and selected state. Transitions background
 * color on hover for interactive feedback.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [data-state] - Selection state ('selected')
 * @property {React.ReactNode} children - TableCell or TableHead elements
 */
const TableRow = React.forwardRef(
  ({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
      className
    )}
    {...props} />
))
TableRow.displayName = "TableRow"

/**
 * Table header cell.
 * 
 * Column header with muted text and aligned checkbox support.
 * Uses medium font weight for visual hierarchy.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {'left' | 'center' | 'right'} [align] - Text alignment
 * @property {React.ReactNode} children - Header content
 */
const TableHead = React.forwardRef(
  ({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className
    )}
    {...props} />
))
TableHead.displayName = "TableHead"

/**
 * Table data cell.
 * 
 * Standard cell with vertical alignment and checkbox support.
 * Padding adjusted when containing checkbox inputs.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Cell content
 */
const TableCell = React.forwardRef(
  ({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className
    )}
    {...props} />
))
TableCell.displayName = "TableCell"

/**
 * Table caption element.
 * 
 * Descriptive text below the table. Uses muted text color
 * and smaller font size.
 * 
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Caption text
 */
const TableCaption = React.forwardRef(
  ({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-muted-foreground", className)}
    {...props} />
))
TableCaption.displayName = "TableCaption"

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
