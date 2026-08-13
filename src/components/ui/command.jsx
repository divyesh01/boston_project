/**
 * @fileoverview Command palette components for keyboard-driven navigation.
 *
 * Built on cmdk (Command Menu Kit) for accessible, keyboard-navigable
 * command palettes. Supports fuzzy search, grouping, and dialog
 * integration for global search overlays (e.g., Cmd+K).
 *
 * @module ui/command
 * @example
 * ```jsx
 * import {
 *   Command,
 *   CommandDialog,
 *   CommandInput,
 *   CommandList,
 *   CommandEmpty,
 *   CommandGroup,
 *   CommandItem,
 *   CommandShortcut,
 *   CommandSeparator,
 * } from "@/components/ui/command";
 *
 * <Command>
 *   <CommandInput placeholder="Type a command..." />
 *   <CommandList>
 *     <CommandEmpty>No results found.</CommandEmpty>
 *     <CommandGroup heading="Suggestions">
 *       <CommandItem>
 *         <span>Calendar</span>
 *       </CommandItem>
 *     </CommandGroup>
 *   </CommandList>
 * </Command>
 * ```
 */

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { Dialog, DialogContent } from "@/components/ui/dialog"

/**
 * Command palette root component.
 *
 * Wraps cmdk's Command primitive with consistent styling. Provides
 * fuzzy search, keyboard navigation, and item selection out of the box.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {string} [label] - Accessible label for the command menu
 * @property {boolean} [shouldFilter] - Enable/disable filtering (default: true)
 * @property {string} [value] - Controlled selected value
 * @property {(value: string) => void} [onValueChange] - Selection change callback
 * @property {React.ReactNode} children - CommandInput, CommandList, etc.
 */
const Command = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
      className
    )}
    {...props} />
))
Command.displayName = CommandPrimitive.displayName

/**
 * Props for CommandDialog component.
 *
 * @typedef {Object} CommandDialogProps
 * @property {React.ReactNode} children - Command component
 * @property {boolean} [open] - Controlled open state
 * @property {(open: boolean) => void} [onOpenChange] - Open state change callback
 */

/**
 * Command palette rendered inside a Dialog overlay.
 *
 * Combines the Command component with a modal Dialog for global
 * search overlays. Typically triggered via Cmd+K keyboard shortcut.
 *
 * @type {React.FC<any>}
 */
const CommandDialog = ({ children, ...props }) => {
  return (
    (<Dialog {...props}>
      <DialogContent className="overflow-hidden p-0">
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          {children}
        </Command>
      </DialogContent>
    </Dialog>)
  );
}

/**
 * Command palette search input.
 *
 * Renders with a search icon prefix. Handles keyboard input
 * for filtering the command list items via fuzzy search.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {string} [placeholder] - Input placeholder text
 */
const CommandInput = React.forwardRef(({ className, ...props }, ref) => (
  <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props} />
  </div>
))

CommandInput.displayName = CommandPrimitive.Input.displayName

/**
 * Command list container.
 *
 * Scrollable container for CommandItem children. Handles
 * empty state display and keyboard navigation between items.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CommandItem components
 */
const CommandList = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
    {...props} />
))

CommandList.displayName = CommandPrimitive.List.displayName

/**
 * Empty state for command list.
 *
 * Displayed when no items match the current search query.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 */
const CommandEmpty = React.forwardRef((props, ref) => (
  <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm" {...props} />
))

CommandEmpty.displayName = CommandPrimitive.Empty.displayName

/**
 * Command group with optional heading.
 *
 * Groups related command items under a styled heading.
 * Headings are muted and smaller than item text.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [heading] - Group heading text
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CommandItem components
 */
const CommandGroup = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
      className
    )}
    {...props} />
))

CommandGroup.displayName = CommandPrimitive.Group.displayName

/**
 * Command separator line.
 *
 * Visual divider between command items or groups.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 */
const CommandSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator ref={ref} className={cn("-mx-1 h-px bg-border", className)} {...props} />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

/**
 * Individual command item.
 *
 * Selectable item with hover/selected states. Supports disabled
 * state and icon rendering via SVG child elements.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [disabled] - Whether item is non-selectable
 * @property {string} [value] - Item value for filtering/selection
 * @property {React.ReactNode} children - Item content
 */
const CommandItem = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props} />
))

CommandItem.displayName = CommandPrimitive.Item.displayName

/**
 * Command keyboard shortcut display.
 *
 * Renders keyboard shortcut text (e.g., "⌘K") aligned to the
 * right side of a CommandItem. Uses muted text color.
 *
 * @type {React.FC<any>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Shortcut text
 */
const CommandShortcut = ({ className, ...props }) => {
  return (
    (<span
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
      {...props} />)
  );
}
CommandShortcut.displayName = "CommandShortcut"

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
