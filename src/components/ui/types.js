/**
 * @fileoverview Shared JSDoc type definitions for UI components.
 * 
 * Centralizes common prop patterns to ensure consistency across
 * all shadcn/ui wrapper components. Import these typedefs in
 * component files for better autocomplete and type safety.
 * 
 * @module ui/types
 * @since 1.0.0
 */

/**
 * Base props shared by all UI wrapper components.
 * Provides className merging and ref forwarding support.
 * 
 * @typedef {Object} BaseProps
 * @property {string} [className] - Additional CSS classes merged via tailwind-merge
 */

/**
 * Props for components that render Radix UI primitives.
 * Extends base props with Radix's composed event handlers.
 * 
 * @template {React.ElementType} T - The Radix primitive component type
 * @typedef {React.ComponentPropsWithoutRef<T> & BaseProps} RadixProps
 */

/**
 * Props for components using the asChild pattern.
 * When true, the component merges its props onto its child
 * instead of rendering a wrapper element.
 * 
 * @typedef {Object} AsChildProps
 * @property {boolean} [asChild] - Merge props onto child element instead of wrapping
 */

/**
 * Props for components that accept variant styling.
 * Used by CVA-powered components like Button.
 * 
 * @typedef {Object} VariantProps
 * @property {'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'} [variant] - Visual style variant
 * @property {'default' | 'sm' | 'lg' | 'icon'} [size] - Size preset affecting padding and font-size
 */

/**
 * Props for components that accept size presets.
 * 
 * @typedef {Object} SizeProps
 * @property {'default' | 'sm' | 'lg' | 'icon'} [size] - Size preset
 */

/**
 * Props for orientation-based components.
 * Used by Carousel, ToggleGroup, etc.
 * 
 * @typedef {Object} OrientationProps
 * @property {'horizontal' | 'vertical'} [orientation] - Layout direction
 */

/**
 * Props for components with disabled state.
 * 
 * @typedef {Object} DisabledProps
 * @property {boolean} [disabled] - Whether the component is non-interactive
 */

/**
 * Props for components that accept an ID for accessibility.
 * 
 * @typedef {Object} AccessibleProps
 * @property {string} [id] - Unique identifier for ARIA relationships
 */

/**
 * Props for components with loading state.
 * 
 * @typedef {Object} LoadingProps
 * @property {boolean} [loading] - Whether the component is in a loading state
 */

/**
 * Props for components that accept a callback on value change.
 * 
 * @template T - The value type
 * @typedef {Object} ChangeHandlerProps
 * @property {(value: T) => void} [onChange] - Callback fired when the value changes
 */

/**
 * Props for components with controlled open state.
 * Used by Dialog, Popover, Dropdown, etc.
 * 
 * @typedef {Object} OpenStateProps
 * @property {boolean} [open] - Controlled open state
 * @property {(open: boolean) => void} [onOpenChange] - Callback when open state changes
 */

/**
 * Props for components that accept a delay before state change.
 * Used by HoverCard, Tooltip, etc.
 * 
 * @typedef {Object} DelayProps
 * @property {number} [delayDuration] - Delay in ms before showing (default: 700)
 * @property {number} [skipDelayDuration] - Duration to skip delay after first show (default: 300)
 */

/**
 * Props for components with collision detection.
 * Used by Popover, Dropdown, Tooltip, etc.
 * 
 * @typedef {Object} CollisionProps
 * @property {'start' | 'center' | 'end'} [align] - Alignment relative to trigger
 * @property {number} [sideOffset] - Distance between trigger and content in px
 * @property {boolean} [avoidCollisions] - Whether to flip when colliding with viewport
 */

/**
 * Props for components with a portal rendering option.
 * 
 * @typedef {Object} PortalProps
 * @property {boolean} [forceMount] - Force mount content even when closed (for SSR)
 */

/**
 * Props for form field components.
 * 
 * @typedef {Object} FormFieldProps
 * @property {string} [name] - Form field name
 * @property {boolean} [required] - Whether the field is required
 * @property {string} [placeholder] - Placeholder text when empty
 */

/**
 * Props for components with a close/dismiss action.
 * Used by Dialog, Alert, Toast, etc.
 * 
 * @typedef {Object} DismissibleProps
 * @property {boolean} [dismissible] - Whether the component can be dismissed
 * @property {() => void} [onDismiss] - Callback fired when dismissed
 */

/**
 * Props for components with animation support.
 * 
 * @typedef {Object} AnimationProps
 * @property {boolean} [animated] - Whether to enable animations
 * @property {number} [animationDuration] - Animation duration in ms
 */

/**
 * Props for components with tooltip text.
 * 
 * @typedef {Object} TooltipContentProps
 * @property {string} [tooltip] - Tooltip text on hover
 */

/**
 * Props for components with badge/indicator support.
 * Used by Avatar, Button, etc.
 * 
 * @typedef {Object} BadgeProps
 * @property {React.ReactNode} [badge] - Badge content to display
 * @property {'default' | 'secondary' | 'destructive' | 'outline'} [badgeVariant] - Badge style variant
 */

/**
 * Props for components with icon support.
 * 
 * @typedef {Object} IconProps
 * @property {React.ReactNode} [icon] - Icon element to display
 * @property {'left' | 'right'} [iconPosition] - Icon position relative to content
 */

/**
 * Props for components with description text.
 * 
 * @typedef {Object} DescriptionProps
 * @property {string} [description] - Descriptive text for accessibility
 */

/**
 * Props for components with error state.
 * 
 * @typedef {Object} ErrorStateProps
 * @property {boolean} [error] - Whether the component is in an error state
 * @property {string} [errorMessage] - Error message to display
 */

/**
 * Props for components with helper text.
 * 
 * @typedef {Object} HelperTextProps
 * @property {string} [helperText] - Helper text displayed below the component
 */

/**
 * Props for components with label.
 * 
 * @typedef {Object} LabelProps
 * @property {string} [label] - Label text for the component
 * @property {string} [htmlFor] - ID of the element the label is bound to
 */

export {}
