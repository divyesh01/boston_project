/**
 * @fileoverview Toaster component for rendering active toast notifications.
 * Consumes the useToast hook and renders Toast components for each active toast.
 * @module toaster
 *
 * WHAT WAS WRONG HERE (tracker #52)
 * ---------------------------------
 * This file used to render `<ToastClose />` with no props. `ToastClose` is a
 * hand-rolled `<button>` with no `onClick` of its own (the shadcn original is a
 * Radix primitive that closes its parent), so the X was a decoration: clicking
 * it did nothing at all. Combined with a state machine that never dispatched
 * DISMISS_TOAST, a toast that appeared on this site stayed on it until the page
 * was reloaded. The owner screenshotted five stacked red toasts over the Add
 * User dialog.
 *
 * It also spread the whole leftover prop bag onto `<Toast>`, which spreads onto
 * a `<div>`. Two of those props are not DOM attributes: `open`, which was
 * rendered as a literal `open` attribute, and `onOpenChange`, which React
 * cannot attach to a div and reports as "Unknown event handler property" in the
 * console. Both are destructured out below and `open` is translated into the
 * `data-state` attribute that `toastVariants` already styles.
 *
 * And it rendered TWO fixed-position containers: `ToastProvider` and
 * `ToastViewport` carried identical class strings, the toasts were children of
 * the provider, and the viewport was left empty. An empty `fixed ... p-4` div
 * is still 32px tall and still accepts pointer events, so every page on the site
 * carried an invisible strip at z-100 that swallowed clicks. See toast.jsx.
 */
import { useToast } from "@/components/ui/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <ToastProvider>
      <ToastViewport>
        {/*
          `onOpenChange` is destructured and then deliberately discarded. It is not
          unused by accident: `Toast` renders a plain <div>, React cannot attach an
          unknown event handler to one, and leaving it in the spread logged
          "Unknown event handler property: onOpenChange" for every toast the app
          showed. Naming it with a leading underscore is how this repo's lint config
          marks an intentionally-dropped binding.
        */}
        {toasts.map(function ({ id, title, description, action, open, onOpenChange: _onOpenChange, ...props }) {
          return (
            <Toast key={id} open={open} {...props}>
              <div className="grid gap-1">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription>{description}</ToastDescription>
                )}
              </div>
              {action}
              {/*
                `dismiss(id)` from the hook, not the toast object's own
                `onOpenChange`. Both would work today, but a caller who passes
                their own `onOpenChange` to `toast()` would overwrite the one the
                store attaches and silently break the close button again. The
                hook's dismiss cannot be overwritten by a caller.
              */}
              <ToastClose onClick={() => dismiss(id)} />
            </Toast>
          );
        })}
      </ToastViewport>
    </ToastProvider>
  );
}
