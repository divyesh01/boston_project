/**
 * @fileoverview Command palette components for keyboard-driven navigation (compiled).
 * @module ui/command
 * @see {@link ./command.jsx} for source with full JSDoc documentation.
 */

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/**
 * Command palette root component.
 * @type {React.ComponentPropsWithoutRef<typeof CommandPrimitive>}
 * @property {string} [className] - Additional CSS classes
 * @property {string} [label] - Accessible label for the command menu
 * @property {boolean} [shouldFilter] - Enable/disable filtering (default: true)
 * @property {string} [value] - Controlled selected value
 * @property {(value: string) => void} [onValueChange] - Selection change callback
 * @property {React.ReactNode} children - CommandInput, CommandList, etc.
 */
const Command = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive, { ref: ref, className: cn("flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground", className), ...props })));
Command.displayName = CommandPrimitive.displayName;

/**
 * Props for CommandDialog component.
 * @typedef {Object} CommandDialogProps
 * @property {React.ReactNode} children - Command component
 * @property {boolean} [open] - Controlled open state
 * @property {(open: boolean) => void} [onOpenChange] - Open state change callback
 */

/**
 * Command palette rendered inside a Dialog overlay.
 * @type {React.FC<CommandDialogProps>}
 */
const CommandDialog = ({ children, ...props }) => {
    return ((_jsx(Dialog, { ...props, children: _jsx(DialogContent, { className: "overflow-hidden p-0", children: _jsx(Command, { className: "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5", children: children }) }) })));
};

/**
 * Command palette search input.
 * @type {React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>}
 * @property {string} [className] - Additional CSS classes
 * @property {string} [placeholder] - Input placeholder text
 */
const CommandInput = React.forwardRef(({ className, ...props }, ref) => (_jsxs("div", { className: "flex items-center border-b px-3", "cmdk-input-wrapper": "", children: [_jsx(Search, { className: "mr-2 h-4 w-4 shrink-0 opacity-50" }), _jsx(CommandPrimitive.Input, { ref: ref, className: cn("flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50", className), ...props })] })));
CommandInput.displayName = CommandPrimitive.Input.displayName;

/**
 * Command list container.
 * @type {React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CommandItem components
 */
const CommandList = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.List, { ref: ref, className: cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className), ...props })));
CommandList.displayName = CommandPrimitive.List.displayName;

/**
 * Empty state for command list.
 * @type {React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>}
 * @property {string} [className] - Additional CSS classes
 */
const CommandEmpty = React.forwardRef((props, ref) => (_jsx(CommandPrimitive.Empty, { ref: ref, className: "py-6 text-center text-sm", ...props })));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

/**
 * Command group with optional heading.
 * @type {React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>}
 * @property {string} [heading] - Group heading text
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CommandItem components
 */
const CommandGroup = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.Group, { ref: ref, className: cn("overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground", className), ...props })));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

/**
 * Command separator line.
 * @type {React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>}
 * @property {string} [className] - Additional CSS classes
 */
const CommandSeparator = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.Separator, { ref: ref, className: cn("-mx-1 h-px bg-border", className), ...props })));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

/**
 * Individual command item.
 * @type {React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>}
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [disabled] - Whether item is non-selectable
 * @property {string} [value] - Item value for filtering/selection
 * @property {React.ReactNode} children - Item content
 */
const CommandItem = React.forwardRef(({ className, ...props }, ref) => (_jsx(CommandPrimitive.Item, { ref: ref, className: cn("relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0", className), ...props })));
CommandItem.displayName = CommandPrimitive.Item.displayName;

/**
 * Command keyboard shortcut display.
 * @type {React.HTMLAttributes<HTMLSpanElement>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Shortcut text
 */
const CommandShortcut = ({ className, ...props }) => {
    return ((_jsx("span", { className: cn("ml-auto text-xs tracking-widest text-muted-foreground", className), ...props })));
};
CommandShortcut.displayName = "CommandShortcut";

export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator, };
