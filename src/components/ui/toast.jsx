/**
 * @fileoverview Toast component for notification display.
 * Provides toast provider, viewport, and individual toast components with dismiss support.
 * @module toast
 *
 * WHAT WAS WRONG HERE (tracker #52 continued)
 * --------------------------------------------
 * The original design shipped both a `ToastProvider` and a `ToastViewport`
 * as identical fixed-position containers with the same class string. The toaster
 * rendered toasts as children of `ToastProvider` and left `ToastViewport` empty.
 * That produced TWO overlapping invisible containers at z-100 on every page —
 * one of them empty and swallowing pointer events for a 32px strip across the
 * right side of every screen.
 *
 * These are now single-responsibility: `ToastViewport` is the one fixed container;
 * `ToastProvider` is a fragment-like wrapper with no positioning of its own. The
 * toaster renders toasts as children of `ToastViewport`.
 *
 * The `open` and `onOpenChange` props used to be spread onto `<Toast>` which is a
 * plain `<div>`. React silently put `open` on the DOM node as a literal attribute,
 * and surfaced `onOpenChange` as an "Unknown event handler property" warning.
 * `open` is now translated to `data-state` and consumed by the `cva` classnames
 * that already reference it (`data-[state=open]:animate-in` etc.).
 * `onOpenChange` is neither needed by nor passed to the DOM element.
 */
import * as React from "react";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Renders nothing of its own. Kept as an export because it is part of the shadcn
 * toast API that `toaster.jsx` and any future consumer expects to import, but it
 * deliberately has no DOM node and no positioning: `ToastViewport` is the single
 * container. It takes no ref for the same reason -- there is nothing to point at.
 */
const ToastProvider = ({ children }) => <>{children}</>;
ToastProvider.displayName = "ToastProvider";

/**
 * The one fixed container that holds every toast.
 *
 * `pointer-events-none` is the fix for the invisible click-swallowing strip: this
 * div spans the full width of the screen on mobile and 420px on desktop, is 32px
 * tall when empty because of `p-4`, and sits at `z-[100]` above everything. Each
 * toast re-enables pointer events for itself via `pointer-events-auto` in
 * `toastVariants`, which is the pairing the original code was missing on both of
 * its two containers.
 *
 * The `@type` below is required, not decoration. `React.forwardRef` gives tsc no
 * prop type to work from in a `.js`/`.jsx` file, so without it the destructured
 * parameter is inferred as `{}` and every prop this component actually takes is
 * a "Property 'className' does not exist on type '{}'" error under
 * `npm run typecheck`. Every forwardRef component in this file carries one.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 */
const ToastViewport = React.forwardRef(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    role="region"
    aria-label="Notifications"
    className={cn(
      "pointer-events-none fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]",
      className
    )}
    {...props}
  >
    {children}
  </div>
));
ToastViewport.displayName = "ToastViewport";

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-8 shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
  {
    variants: {
      variant: {
        default: "border bg-background text-foreground",
        destructive:
          "destructive group border-destructive bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

/**
 * One toast.
 *
 * `open` is translated into `data-state`, which is what every animation class in
 * `toastVariants` keys off (`data-[state=open]:animate-in`,
 * `data-[state=closed]:animate-out`, `fade-out-80`, `slide-out-to-right-full`).
 * Before this, `open` was spread straight onto the div and no element in the app
 * ever carried a `data-state` attribute, so all of those classes were dead: a
 * toast appeared and disappeared with no transition, and `open: false` hid
 * nothing at all because nothing read it.
 *
 * `open` defaults to `true` so a `<Toast>` rendered directly, without the store,
 * is visible rather than pre-animated-out.
 *
 * The two ARIA roles are split by variant on purpose. A destructive toast is the
 * only feedback an admin gets when a save is refused, so it interrupts
 * (`role="alert"` / `aria-live="assertive"`); a confirmation waits for a pause
 * (`role="status"` / `aria-live="polite"`) instead of talking over whatever the
 * screen reader is in the middle of.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 */
const Toast = React.forwardRef(({ className, variant, open = true, ...props }, ref) => {
  const destructive = variant === "destructive";
  return (
    <div
      ref={ref}
      data-state={open ? "open" : "closed"}
      role={destructive ? "alert" : "status"}
      aria-live={destructive ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  );
});
Toast.displayName = "Toast";

/** @type {React.ForwardRefExoticComponent<any>} */
/** @type {React.ForwardRefExoticComponent<any>} */
const ToastAction = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 group-[.destructive]:hover:border-destructive/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive",
      className
    )}
    {...props}
  />
));
ToastAction.displayName = "ToastAction";

/**
 * The close button.
 *
 * `type="button"` matters because a toast can be rendered over an open form (the
 * Add User dialog is exactly where the owner hit this): a `<button>` with no type
 * defaults to `type="submit"`, so dismissing a validation toast inside a form
 * would have submitted that form.
 *
 * It no longer relies on `group-hover` to become visible. Hover does not exist on
 * a touch screen, so the previous `opacity-0 group-hover:opacity-100` made the X
 * permanently invisible -- though still clickable -- on a phone. It is drawn at
 * reduced contrast and comes to full strength on hover or focus instead.
 *
 * The accessible name is a visually hidden span rather than `aria-label`, so it is
 * translated by page-level translation the same way the rest of the UI is. The
 * icon is hidden from the accessibility tree so the button announces once.
 *
 * @type {React.ForwardRefExoticComponent<any>}
 */
const ToastClose = React.forwardRef(({ className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-70 transition-opacity hover:text-foreground hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 group-[.destructive]:text-red-300 group-[.destructive]:hover:text-red-50 group-[.destructive]:focus:ring-red-400 group-[.destructive]:focus:ring-offset-red-600",
      className
    )}
    toast-close=""
    {...props}
  >
    <span className="sr-only">Close notification</span>
    <X className="h-4 w-4" aria-hidden="true" />
  </button>
));
ToastClose.displayName = "ToastClose";

/** @type {React.ForwardRefExoticComponent<any>} */
/** @type {React.ForwardRefExoticComponent<any>} */
const ToastTitle = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm font-semibold", className)}
    {...props}
  />
));
ToastTitle.displayName = "ToastTitle";

/** @type {React.ForwardRefExoticComponent<any>} */
/** @type {React.ForwardRefExoticComponent<any>} */
const ToastDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm opacity-90", className)}
    {...props}
  />
));
ToastDescription.displayName = "ToastDescription";

export {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
}; 