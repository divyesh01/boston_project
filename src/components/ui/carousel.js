/**
 * @fileoverview Carousel component for swipeable content slides (compiled).
 * @module ui/carousel
 * @see {@link ./carousel.jsx} for source with full JSDoc documentation.
 */

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const CarouselContext = React.createContext(null);

/**
 * Hook to access carousel context.
 * @typedef {Object} CarouselContextValue
 * @property {HTMLElement} carouselRef - The scroll container element
 * @property {any} api - Embla Carousel API instance
 * @property {any} opts - Embla Carousel options
 * @property {"horizontal" | "vertical"} orientation - Layout direction
 * @property {() => void} scrollPrev - Scroll to previous slide
 * @property {() => void} scrollNext - Scroll to next slide
 * @property {boolean} canScrollPrev - Whether previous scroll is possible
 * @property {boolean} canScrollNext - Whether next scroll is possible
 * @returns {CarouselContextValue} Carousel context value
 */
function useCarousel() {
    const context = React.useContext(CarouselContext);
    if (!context) {
        throw new Error("useCarousel must be used within a <Carousel />");
    }
    return context;
}

/**
 * Props for Carousel component.
 * @typedef {Object} CarouselProps
 * @property {"horizontal" | "vertical"} [orientation] - Layout direction
 * @property {any} [opts] - Embla Carousel configuration options
 * @property {(api: any) => void} [setApi] - Callback to access Embla API
 * @property {Array<any>} [plugins] - Embla Carousel plugins
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CarouselContent component
 */

/**
 * Carousel root component.
 * @type {CarouselProps}
 * @property {"horizontal" | "vertical"} [orientation="horizontal"] - Layout direction
 * @property {any} [opts] - Embla Carousel configuration
 * @property {(api: any) => void} [setApi] - Callback to access Embla API
 * @property {Array<any>} [plugins] - Embla plugins
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - CarouselContent component
 */
const Carousel = React.forwardRef(({ orientation = "horizontal", opts, setApi, plugins, className, children, ...props }, ref) => {
    const [carouselRef, api] = useEmblaCarousel({
        ...opts,
        axis: orientation === "horizontal" ? "x" : "y",
    }, plugins);
    const [canScrollPrev, setCanScrollPrev] = React.useState(false);
    const [canScrollNext, setCanScrollNext] = React.useState(false);
    const onSelect = React.useCallback((api) => {
        if (!api) { return; }
        setCanScrollPrev(api.canScrollPrev());
        setCanScrollNext(api.canScrollNext());
    }, []);
    const scrollPrev = React.useCallback(() => { api?.scrollPrev(); }, [api]);
    const scrollNext = React.useCallback(() => { api?.scrollNext(); }, [api]);
    const handleKeyDown = React.useCallback((event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); scrollPrev(); }
        else if (event.key === "ArrowRight") { event.preventDefault(); scrollNext(); }
    }, [scrollPrev, scrollNext]);
    React.useEffect(() => {
        if (!api || !setApi) { return; }
        setApi(api);
    }, [api, setApi]);
    React.useEffect(() => {
        if (!api) { return; }
        onSelect(api);
        api.on("reInit", onSelect);
        api.on("select", onSelect);
        return () => { api?.off("select", onSelect); };
    }, [api, onSelect]);
    return ((_jsx(CarouselContext.Provider, { value: {
            carouselRef, api: api, opts,
            orientation: orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
            scrollPrev, scrollNext, canScrollPrev, canScrollNext,
        }, children: _jsx("div", { ref: ref, onKeyDownCapture: handleKeyDown, className: cn("relative", className), role: "region", "aria-roledescription": "carousel", ...props, children: children }) })));
});
Carousel.displayName = "Carousel";

/**
 * Carousel content track.
 * @type {React.HTMLAttributes<HTMLDivElement>}
 * @property {string} [className] - Additional CSS classes for the track
 * @property {React.ReactNode} children - CarouselItem components
 */
const CarouselContent = React.forwardRef(({ className, ...props }, ref) => {
    const { carouselRef, orientation } = useCarousel();
    return ((_jsx("div", { ref: carouselRef, className: "overflow-hidden", children: _jsx("div", { ref: ref, className: cn("flex", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", className), ...props }) })));
});
CarouselContent.displayName = "CarouselContent";

/**
 * Individual carousel slide.
 * @type {React.HTMLAttributes<HTMLDivElement>}
 * @property {string} [className] - Additional CSS classes
 * @property {React.ReactNode} children - Slide content
 */
const CarouselItem = React.forwardRef(({ className, ...props }, ref) => {
    const { orientation } = useCarousel();
    return ((_jsx("div", { ref: ref, role: "group", "aria-roledescription": "slide", className: cn("min-w-0 shrink-0 grow-0 basis-full", orientation === "horizontal" ? "pl-4" : "pt-4", className), ...props })));
});
CarouselItem.displayName = "CarouselItem";

/**
 * Previous slide navigation button.
 * @type {React.ComponentPropsWithoutRef<typeof Button>}
 * @property {"default" | "destructive" | "outline" | "secondary" | "ghost" | "link"} [variant="outline"] - Button style
 * @property {"default" | "sm" | "lg" | "icon"} [size="icon"] - Button size
 * @property {string} [className] - Additional CSS classes
 */
const CarouselPrevious = React.forwardRef(({ className, variant = "outline", size = "icon", ...props }, ref) => {
    const { orientation, scrollPrev, canScrollPrev } = useCarousel();
    return ((_jsxs(Button, { ref: ref, variant: variant, size: size, className: cn("absolute  h-8 w-8 rounded-full", orientation === "horizontal"
            ? "-left-12 top-1/2 -translate-y-1/2"
            : "-top-12 left-1/2 -translate-x-1/2 rotate-90", className), disabled: !canScrollPrev, onClick: scrollPrev, ...props, children: [_jsx(ArrowLeft, { className: "h-4 w-4" }), _jsx("span", { className: "sr-only", children: "Previous slide" })] })));
});
CarouselPrevious.displayName = "CarouselPrevious";

/**
 * Next slide navigation button.
 * @type {React.ComponentPropsWithoutRef<typeof Button>}
 * @property {"default" | "destructive" | "outline" | "secondary" | "ghost" | "link"} [variant="outline"] - Button style
 * @property {"default" | "sm" | "lg" | "icon"} [size="icon"] - Button size
 * @property {string} [className] - Additional CSS classes
 */
const CarouselNext = React.forwardRef(({ className, variant = "outline", size = "icon", ...props }, ref) => {
    const { orientation, scrollNext, canScrollNext } = useCarousel();
    return ((_jsxs(Button, { ref: ref, variant: variant, size: size, className: cn("absolute h-8 w-8 rounded-full", orientation === "horizontal"
            ? "-right-12 top-1/2 -translate-y-1/2"
            : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90", className), disabled: !canScrollNext, onClick: scrollNext, ...props, children: [_jsx(ArrowRight, { className: "h-4 w-4" }), _jsx("span", { className: "sr-only", children: "Next slide" })] })));
});
CarouselNext.displayName = "CarouselNext";

export { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext };
