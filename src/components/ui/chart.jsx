"use client";

/**
 * @fileoverview Chart components for data visualization with Recharts.
 *
 * Provides accessible, theme-aware chart components with CSS variable
 * color scoping. Each chart generates a unique ID to prevent multiple
 * charts on one page from overriding each other's theme colors.
 *
 * @module ui/chart
 * @example
 * ```jsx
 * import {
 *   ChartContainer,
 *   ChartTooltip,
 *   ChartTooltipContent,
 *   ChartLegend,
 *   ChartLegendContent,
 * } from "@/components/ui/chart";
 *
 * const config = {
 *   revenue: { label: "Revenue", color: "hsl(var(--chart-1))" },
 *   expenses: { label: "Expenses", color: "hsl(var(--chart-2))" },
 * };
 *
 * <ChartContainer config={config} className="h-[300px]">
 *   <LineChart data={data}>
 *     <ChartTooltip content={<ChartTooltipContent />} />
 *     <ChartLegend content={<ChartLegendContent />} />
 *     <Line dataKey="revenue" />
 *     <Line dataKey="expenses" />
 *   </LineChart>
 * </ChartContainer>
 * ```
 */

import * as React from "react"
import DOMPurify from "dompurify"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/decimal"

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = {
  light: "",
  dark: ".dark"
}

const ChartContext = React.createContext(null)

/**
 * Hook to access chart configuration context.
 *
 * Must be used within a ChartContainer component. Provides access
 * to the chart config for color/icon resolution.
 *
 * @returns {{ config: ChartConfig }} Chart context value
 * @throws {Error} If used outside of ChartContainer
 */
function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }

  return context
}

/**
 * Chart theme configuration mapping data keys to display properties.
 *
 * @typedef {Object} ChartConfigItem
 * @property {string} label - Human-readable name for this data series
 * @property {string} [color] - Static color value (hex, hsl, etc.)
 * @property {Object} [theme] - Theme-specific color overrides
 * @property {string} [theme.light] - Light theme color
 * @property {string} [theme.dark] - Dark theme color
 * @property {React.ComponentType} [icon] - Optional icon component for legend/tooltip
 */

/**
 * @typedef {Record<string, ChartConfigItem>} ChartConfig
 */

/**
 * Props for ChartContainer component.
 *
 * @typedef {Object} ChartContainerProps
 * @property {string} [id] - Unique identifier for CSS variable scoping
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Recharts chart components
 * @property {ChartConfig} config - Theme configuration mapping
 */

/**
 * Chart container with CSS variable theme scoping.
 *
 * Wraps Recharts components and generates unique CSS custom properties
 * for each data series. This prevents multiple charts on one page from
 * overriding each other's colors.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 * @property {string} [id] - Unique identifier for CSS scoping
 * @property {string} [className] - Wrapper CSS classes
 * @property {React.ReactNode} children - Recharts chart elements
 * @property {ChartConfig} config - Data series color/icon configuration
 */
const ChartContainer = React.forwardRef(({ id, className, children, config, ...props }, ref) => {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`

  return (
    (<ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        ref={ref}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#']]:stroke-border [&_.recharts-sector[stroke='#']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
          className
        )}
        {...props}>
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>)
  );
})
ChartContainer.displayName = "Chart"

/**
 * Props for ChartStyle component.
 *
 * @typedef {Object} ChartStyleProps
 * @property {string} id - Chart unique identifier for CSS scoping
 * @property {ChartConfig} config - Data series color configuration
 */

/**
 * Renders CSS custom properties for chart theme colors.
 *
 * Generates a <style> element with CSS variables scoped to this
 * chart's unique ID. Each data series gets a --color-{key} variable
 * that Recharts can reference via hsl(var(--color-{key})).
 *
 * @type {React.FC<ChartStyleProps>}
 */
const ChartStyle = ({
  id,
  config
}) => {
  const colorConfig = Object.entries(config || {}).filter(([, config]) => config && (config.theme || config.color))

  if (!colorConfig.length) {
    return null
  }

  const rawHtml = Object.entries(THEMES)
    .map(([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const rawColor =
      itemConfig.theme?.[theme] ||
      itemConfig.color;
    const color = rawColor ? String(rawColor).replace(/[^a-zA-Z0-9#(),. %\-]/g, '') : null;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .join("\n")}
}
`)
    .join("\n");

  return (
    (<style
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(rawHtml, { ALLOWED_TAGS: ['style'], FORCE_BODY: false }),
      }} />)
  );
}

/**
 * Recharts Tooltip primitive wrapper.
 * @type {typeof RechartsPrimitive.Tooltip}
 */
const ChartTooltip = RechartsPrimitive.Tooltip

/**
 * Props for ChartTooltipContent component.
 *
 * @typedef {Object} ChartTooltipContentProps
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
 * Chart tooltip content with automatic config resolution.
 *
 * Displays formatted data values with color indicators that match
 * the chart's theme configuration. Resolves labels and icons from
 * the ChartConfig passed to ChartContainer.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 */
const ChartTooltipContent = React.forwardRef((
  {
    active,
    payload,
    className,
    indicator = "dot",
    hideLabel = false,
    hideIndicator = false,
    label,
    labelFormatter,
    labelClassName,
    formatter,
    color,
    nameKey,
    labelKey,
  },
  ref
) => {
  const { config } = useChart()

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null
    }

    const [item] = payload
    const key = `${labelKey || item.dataKey || item.name || "value"}`
    const itemConfig = getPayloadConfigFromPayload(config, item, key)
    const value =
      !labelKey && typeof label === "string"
        ? config[label]?.label || label
        : itemConfig?.label

    if (labelFormatter) {
      return (
        (<div className={cn("font-medium", labelClassName)}>
          {labelFormatter(value, payload)}
        </div>)
      );
    }

    if (!value) {
      return null
    }

    return <div className={cn("font-medium", labelClassName)}>{value}</div>;
  }, [
    label,
    labelFormatter,
    payload,
    hideLabel,
    labelClassName,
    config,
    labelKey,
  ])

  if (!active || !payload?.length) {
    return null
  }

  const nestLabel = payload.length === 1 && indicator !== "dot"

  return (
    (<div
      ref={ref}
      className={cn(
        "grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
        className
      )}>
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = `${nameKey || item.name || item.dataKey || "value"}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)
          const indicatorColor = color || item.payload.fill || item.color

          return (
            (<div
              key={item.dataKey}
              className={cn(
                "flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground",
                indicator === "dot" && "items-center"
              )}>
              {formatter && item?.value !== undefined && item.name ? (
                formatter(item.value, item.name, item, index, item.payload)
              ) : (
                <>
                  {itemConfig?.icon ? (
                    <itemConfig.icon />
                  ) : (
                    !hideIndicator && (
                      <div
                        className={cn("shrink-0 rounded-[2px] border-[--color-border] bg-[--color-bg]", {
                          "h-2.5 w-2.5": indicator === "dot",
                          "w-1": indicator === "line",
                          "w-0 border-[1.5px] border-dashed bg-transparent":
                            indicator === "dashed",
                          "my-0.5": nestLabel && indicator === "dashed",
                        })}
                        style={{
                          "--color-bg": indicatorColor,
                          "--color-border": indicatorColor
                        }} />
                    )
                  )}
                  <div
                    className={cn(
                      "flex flex-1 justify-between leading-none",
                      nestLabel ? "items-end" : "items-center"
                    )}>
                    <div className="grid gap-1.5">
                      {nestLabel ? tooltipLabel : null}
                      <span className="text-muted-foreground">
                        {itemConfig?.label || item.name}
                      </span>
                    </div>
                    {item.value && (
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {formatNumber(item.value, 'auto')}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>)
          );
        })}
      </div>
    </div>)
  );
})
ChartTooltipContent.displayName = "ChartTooltip"

/**
 * Recharts Legend primitive wrapper.
 * @type {typeof RechartsPrimitive.Legend}
 */
const ChartLegend = RechartsPrimitive.Legend

/**
 * Props for ChartLegendContent component.
 *
 * @typedef {Object} ChartLegendContentProps
 * @property {string} [className] - Additional CSS classes
 * @property {boolean} [hideIcon=false] - Hide series color icons
 * @property {Array<any>} [payload] - Recharts legend payload array
 * @property {'top' | 'bottom'} [verticalAlign='bottom'] - Legend position
 * @property {string} [nameKey] - Key to extract item name from payload
 */

/**
 * Chart legend content with config-driven styling.
 *
 * Renders interactive legend items with colors and icons matching
 * the ChartConfig. Clicking a legend item toggles the visibility
 * of the corresponding data series.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 */
const ChartLegendContent = React.forwardRef((
  { className, hideIcon = false, payload, verticalAlign = "bottom", nameKey },
  ref
) => {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    (<div
      ref={ref}
      className={cn(
        "flex items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className
      )}>
      {payload.map((item) => {
        const key = `${nameKey || item.dataKey || "value"}`
        const itemConfig = getPayloadConfigFromPayload(config, item, key)

        return (
          (<div
            key={item.value}
            className={cn(
              "flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground"
            )}>
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: item.color,
                }} />
            )}
            {itemConfig?.label}
          </div>)
        );
      })}
    </div>)
  );
})
ChartLegendContent.displayName = "ChartLegend"

/**
 * Helper to extract item config from a Recharts payload.
 *
 * Resolves the correct config key by checking the payload object
 * and its nested payload property for string values that match
 * config keys.
 *
 * @param {ChartConfig} config - The chart configuration object
 * @param {any} payload - The Recharts payload item
 * @param {string} key - The initial key to look up
 * @returns {ChartConfigItem | undefined} The resolved config item
 */
function getPayloadConfigFromPayload(
  config,
  payload,
  key
) {
  if (typeof payload !== "object" || payload === null) {
    return undefined
  }

  const payloadPayload =
    "payload" in payload &&
    typeof payload.payload === "object" &&
    payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey = key

  if (
    key in payload &&
    typeof payload[key] === "string"
  ) {
    configLabelKey = payload[key]
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key] === "string"
  ) {
    configLabelKey = payloadPayload[key]
  }

  return configLabelKey in config
    ? config[configLabelKey]
    : config[key];
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
}
