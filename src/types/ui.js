/**
 * @fileoverview Comprehensive type system for the RRI Executive UI library.
 * 
 * This module provides centralized JSDoc type definitions that are imported
 * by all UI components. Unlike the previous types.js (which was never imported),
 * these types are actively consumed throughout the component library.
 * 
 * @module types/ui
 * @since 2.0.0
 * @example
 * ```jsx
 * import { BaseProps, RadixProps } from '@/types/ui';
 * ```
 */

/**
 * @typedef {Object} BaseProps
 * Base props shared by all UI wrapper components.
 * @property {string} [className] - Additional CSS classes merged via tailwind-merge
 */

/**
 * @template T - The Radix primitive component type
 * @typedef {Object} RadixProps
 * Props for components that render Radix UI primitives.
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Child elements
 */

/**
 * @typedef {Object} AsChildProps
 * Props for components using the asChild pattern.
 * When true, the component merges its props onto its child
 * instead of rendering a wrapper element.
 * @property {boolean} [asChild] - Merge props onto child element instead of wrapping
 */

/**
 * @typedef {Object} SizeProps
 * Props for components that accept size presets.
 * @property {'default' | 'sm' | 'lg' | 'icon'} [size] - Size preset affecting padding and dimensions
 */

/**
 * @typedef {Object} VariantProps
 * Props for components using CVA variant styling.
 * @property {'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'} [variant] - Visual style variant
 * @property {'default' | 'sm' | 'lg' | 'icon'} [size] - Size preset
 */

/**
 * @typedef {Object} OrientationProps
 * Props for orientation-based components.
 * @property {'horizontal' | 'vertical'} [orientation] - Layout direction
 */

/**
 * @typedef {Object} OpenStateProps
 * Props for components with controlled open state.
 * @property {boolean} [open] - Controlled open state
 * @property {(open: boolean) => void} [onOpenChange] - Callback when open state changes
 */

/**
 * @typedef {Object} LoadingProps
 * Props for components with loading state.
 * @property {boolean} [isLoading] - Whether the component is in a loading state
 * @property {string} [loadingText] - Text to display during loading
 */

/**
 * @typedef {Object} ErrorStateProps
 * Props for components with error state.
 * @property {boolean} [hasError] - Whether the component is in an error state
 * @property {string} [errorMessage] - Error message to display
 * @property {() => void} [onRetry] - Callback to retry the failed operation
 */

/**
 * @typedef {Object} AccessibleProps
 * Props for accessibility attributes.
 * @property {string} [ariaLabel] - Accessible label for screen readers
 * @property {string} [ariaDescribedBy] - ID of element that describes this component
 * @property {string} [ariaLabelledBy] - ID of element that labels this component
 * @property {boolean} [ariaHidden] - Whether component is hidden from screen readers
 */

/**
 * @typedef {Object} FormFieldProps
 * Props for form field components.
 * @property {string} [name] - Form field name
 * @property {boolean} [isRequired] - Whether the field is required
 * @property {boolean} [isDisabled] - Whether the field is disabled
 * @property {string} [placeholder] - Placeholder text when empty
 * @property {string} [error] - Validation error message
 */

/**
 * @typedef {Object} ChartConfigItem
 * Chart theme configuration for a single data series.
 * @property {string} label - Human-readable name for this data series
 * @property {string} [color] - Static color value (hex, hsl, etc.)
 * @property {Object} [theme] - Theme-specific color overrides
 * @property {string} [theme.light] - Light theme color
 * @property {string} [theme.dark] - Dark theme color
 * @property {React.ComponentType} [icon] - Optional icon component for legend/tooltip
 */

/**
 * @typedef {Record<string, ChartConfigItem>} ChartConfig
 * Chart theme configuration mapping data keys to display properties.
 */

/**
 * @typedef {Object} ChartContainerProps
 * Props for ChartContainer component.
 * @property {string} [id] - Unique identifier for CSS variable scoping
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Recharts chart components
 * @property {ChartConfig} config - Theme configuration mapping
 */

/**
 * @typedef {Object} ChartTooltipContentProps
 * Props for ChartTooltipContent component.
 * @property {boolean} [active] - Whether tooltip is currently visible
 * @property {Array<any>} [payload] - Recharts data payload array
 * @property {string} [className] - Additional CSS classes
 * @property {'dot' | 'line' | 'dashed'} [indicator='dot'] - Visual indicator style
 * @property {boolean} [hideLabel=false] - Hide the category label
 * @property {boolean} [hideIndicator=false] - Hide color indicators
 * @property {string | number} [label] - Category label value
 * @property {(value: any, payload: any[]) => React.ReactNode} [labelFormatter] - Custom label renderer
 * @property {string} [labelClassName] - CSS classes for label element
 * @property {(value: any, name: string, item: any, index: number, payload: any) => React.ReactNode} [formatter] - Custom value formatter
 * @property {string} [color] - Override indicator color
 * @property {string} [nameKey] - Key to extract item name from payload
 * @property {string} [labelKey] - Key to extract label from payload
 */

/**
 * @typedef {Object} ChartLegendContentProps
 * Props for ChartLegendContent component.
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [hideIcon=false] - Hide series color icons
 * @property {Array<any>} [payload] - Recharts legend payload array
 * @property {'top' | 'bottom'} [verticalAlign='bottom'] - Legend position
 * @property {string} [nameKey] - Key to extract item name from payload
 */

/**
 * @typedef {Object} CommandDialogProps
 * Props for CommandDialog component.
 * @property {React.ReactNode} children - Command component
 * @property {boolean} [open] - Controlled open state
 * @property {(open: boolean) => void} [onOpenChange] - Open state change callback
 */

/**
 * @typedef {Object} CarouselContextValue
 * Carousel context value provided by Carousel component.
 * @property {HTMLElement} carouselRef - The scroll container element
 * @property {any} api - Embla Carousel API instance
 * @property {any} opts - Embla Carousel options
 * @property {'horizontal' | 'vertical'} orientation - Layout direction
 * @property {() => void} scrollPrev - Scroll to previous slide
 * @property {() => void} scrollNext - Scroll to next slide
 * @property {boolean} canScrollPrev - Whether previous scroll is possible
 * @property {boolean} canScrollNext - Whether next scroll is possible
 */

/**
 * @typedef {Object} CarouselProps
 * Props for Carousel component.
 * @property {'horizontal' | 'vertical'} [orientation] - Layout direction
 * @property {any} [opts] - Embla Carousel configuration options
 * @property {(api: any) => void} [setApi] - Callback to access Embla API
 * @property {Array<any>} [plugins] - Embla Carousel plugins
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CarouselContent component
 */

/**
 * @typedef {Object} BreadcrumbLinkProps
 * Props for BreadcrumbLink component.
 * @property {boolean} [asChild] - Merge props onto child instead of rendering <a>
 * @property {string} [href] - Link destination
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Link text content
 */

/**
 * @typedef {Object} BreadcrumbSeparatorProps
 * Props for BreadcrumbSeparator component.
 * @property {React.ReactNode} [children] - Custom separator content (default: ChevronRight)
 * @property {string} [className] - Additional CSS classes
 */

/**
 * @typedef {Object} PaginationProps
 * Props for Pagination component.
 * @property {number} total - Total number of items
 * @property {number} perPage - Items per page
 * @property {number} current - Current page number (1-indexed)
 * @property {(page: number) => void} onPageChange - Page change callback
 * @property {string} [className] - Additional CSS classes
 */

/**
 * @typedef {Object} DataTableProps
 * Props for DataTable component.
 * @property {Array<any>} data - Array of data rows
 * @property {Array<{key: string, label: string, sortable?: boolean}>} columns - Column definitions
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [isLoading] - Loading state
 * @property {string} [emptyMessage] - Message when no data
 * @property {(row: any) => void} [onRowClick] - Row click callback
 */

/**
 * @typedef {Object} EmptyStateProps
 * Props for EmptyState component.
 * @property {React.ReactNode} [icon] - Icon to display
 * @property {string} title - Main title text
 * @property {string} [description] - Secondary description text
 * @property {React.ReactNode} [action] - Action button/element
 * @property {string} [className] - Additional CSS classes
 */

/**
 * @typedef {Object} LoadingComponentProps
 * Props for Loading component.
 * @property {string} [size='md'] - Size preset (sm, md, lg)
 * @property {string} [text] - Loading text to display
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [fullPage] - Whether to display as full-page overlay
 */

/**
 * @typedef {Object} ErrorBoundaryProps
 * Props for ErrorBoundary component.
 * @property {React.ReactNode} children - Child components
 * @property {React.ReactNode} [fallback] - Custom fallback UI
 * @property {(error: Error, errorInfo: React.ErrorInfo) => void} [onError] - Error callback
 */

/**
 * @typedef {Object} ConfirmDialogProps
 * Props for ConfirmDialog component.
 * @property {boolean} open - Controlled open state
 * @property {(open: boolean) => void} onOpenChange - Open state change callback
 * @property {string} title - Dialog title
 * @property {string} description - Dialog description
 * @property {string} [confirmText='Confirm'] - Confirm button text
 * @property {string} [cancelText='Cancel'] - Cancel button text
 * @property {() => void} onConfirm - Confirm action callback
 * @property {'default' | 'destructive'} [variant='default'] - Visual variant
 */

/**
 * @typedef {Object} KpiCardProps
 * Props for KpiCard component.
 * @property {string} label - Metric label
 * @property {string | number} value - Metric value
 * @property {string} [change] - Change indicator (e.g., "+12.5%")
 * @property {'up' | 'down' | 'neutral'} [trend] - Trend direction
 * @property {React.ReactNode} [icon] - Icon component
 * @property {string} [className] - Additional CSS classes
 */

/**
 * @typedef {Object} StatusBadgeProps
 * Props for StatusBadge component.
 * @property {'success' | 'warning' | 'error' | 'info' | 'neutral'} status - Status type
 * @property {string} label - Display text
 * @property {boolean} [pulse] - Whether to show pulse animation
 * @property {string} [className] - Additional CSS classes
 */

/**
 * @typedef {Object} DateRange
 * Date range for filters and pickers.
 * @property {Date} [from] - Start date
 * @property {Date} [to] - End date
 */

/**
 * @typedef {Object} FilterBarProps
 * Props for FilterBar component.
 * @property {DateRange} [dateRange] - Selected date range
 * @property {(range: DateRange) => void} onDateRangeChange - Date range change callback
 * @property {string} [propertyId] - Selected property ID
 * @property {(id: string) => void} onPropertyChange - Property change callback
 * @property {string} [className] - Additional CSS classes
 */

/**
 * @typedef {Object} StatCardProps
 * Props for StatCard component.
 * @property {string} title - Stat title
 * @property {string | number} value - Stat value
 * @property {React.ReactNode} [icon] - Icon component
 * @property {string} [subtitle] - Subtitle text
 * @property {string} [trend] - Trend indicator
 * @property {string} [className] - Additional CSS classes
 */

export {};
