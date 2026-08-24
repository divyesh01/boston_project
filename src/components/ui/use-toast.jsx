/**
 * @fileoverview Toast state management hook and API.
 * Provides useToast hook and toast() function for programmatic toast notifications.
 * Uses a global reducer pattern with listener-based state synchronization.
 * @module use-toast
 */
// Inspired by react-hot-toast library
import { useState, useEffect } from "react";

/**
 * How many toasts may be on screen at once.
 *
 * Was 20. Nothing ever removed a toast (see the note on TOAST_REMOVE_DELAY), so
 * 20 was not a burst allowance, it was a permanent ceiling: the owner
 * screenshotted five stacked red toasts covering the Add User dialog, and the
 * only way to clear them was a page reload. Twenty toasts is roughly 1800px of
 * stack in a container with `max-h-screen` and no scroll, so the oldest ones
 * were clipped out of the viewport entirely and could not be read even in
 * principle.
 *
 * Three is a burst allowance. `ADD_TOAST` prepends and slices, so the three
 * KEPT are the three NEWEST; a fourth simultaneous toast drops the oldest.
 * That is a real trade-off and it is the right way round: the newest message
 * is the one the admin's last click produced.
 */
const TOAST_LIMIT = 3;

/**
 * How long a dismissed toast stays mounted so its exit animation can play.
 *
 * Was 1_000_000 (16.7 minutes). That number is the upstream react-hot-toast
 * placeholder and it was never the intended lifetime — it is the delay between
 * "start closing" and "unmount", which upstream expects to be a few hundred
 * milliseconds. It never mattered before because nothing dispatched
 * DISMISS_TOAST at all, so this timer was never armed.
 *
 * 200ms is measured, not guessed. `toastVariants` in toast.jsx carries
 * `data-[state=closed]:animate-out`, and the Tailwind CLI compiles that to
 * `animation-name: exit; animation-duration: .15s`. So the exit takes 150ms and
 * the element must outlive it. 200ms gives it 50ms of headroom.
 */
const TOAST_REMOVE_DELAY = 200;

/**
 * How long a toast stays up before it starts closing, by variant.
 *
 * Errors get twice as long as confirmations because they carry more text and
 * because acting on them requires reading them. `validateUserForm` can now
 * return several rules in one destructive toast, which is the longest string
 * this system renders.
 *
 * A caller can override per toast with `toast({ duration })`. Pass `Infinity`,
 * `null` or `0` for a toast that stays until the admin closes it — appropriate
 * for a failure they must act on, never for a success.
 */
const DEFAULT_DURATION_MS = { default: 5000, destructive: 10000 };

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
};

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
}

/**
 * Timers, in two maps because a toast has two deadlines.
 *
 * `removeTimers`  DISMISS -> REMOVE. Armed when a toast starts closing; unmounts
 *                 it once the exit animation has played.
 * `dismissTimers` ADD -> DISMISS. Armed when a toast appears; starts the close.
 *                 THIS IS THE ONE THAT DID NOT EXIST. Without it nothing ever
 *                 dispatched DISMISS_TOAST, so `removeTimers` was never armed,
 *                 so REMOVE_TOAST was never dispatched, so no toast this app has
 *                 ever shown left the screen on its own.
 */
const removeTimers = new Map();
const dismissTimers = new Map();

const clearTimer = (map, toastId) => {
  const timeout = map.get(toastId);
  if (timeout !== undefined) {
    clearTimeout(timeout);
    map.delete(toastId);
  }
};

const addToRemoveQueue = (toastId) => {
  if (removeTimers.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    removeTimers.delete(toastId);
    dispatch({
      type: actionTypes.REMOVE_TOAST,
      toastId,
    });
  }, TOAST_REMOVE_DELAY);

  removeTimers.set(toastId, timeout);
};

export const reducer = (state, action) => {
  switch (action.type) {
    case actionTypes.ADD_TOAST: {
      const next = [action.toast, ...state.toasts].slice(0, TOAST_LIMIT);
      // A toast pushed off the end by TOAST_LIMIT is gone from state but still
      // owns two timers. Clearing them here keeps one invariant true, which the
      // probe asserts: a timer exists only for a toast that is still on screen.
      state.toasts.forEach((t) => {
        if (!next.some((n) => n.id === t.id)) {
          clearTimer(dismissTimers, t.id);
          clearTimer(removeTimers, t.id);
        }
      });
      return { ...state, toasts: next };
    }

    case actionTypes.UPDATE_TOAST:
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };

    case actionTypes.DISMISS_TOAST: {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      //
      // The pending auto-dismiss is cancelled here as well as queued for removal.
      // A toast can reach this branch two ways -- its own timer fired, or the
      // admin clicked the X -- and on the click path the timer is still pending.
      // Left armed it would fire against an id that no longer exists and arm a
      // second removal for nothing.
      if (toastId) {
        clearTimer(dismissTimers, toastId);
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          clearTimer(dismissTimers, toast.id);
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      };
    }
    case actionTypes.REMOVE_TOAST:
      // Unmounting is the last thing that happens to a toast, so both of its
      // timers are dead weight from here on. Dropping them keeps the two maps
      // from growing for the life of the tab.
      if (action.toastId === undefined) {
        state.toasts.forEach((t) => {
          clearTimer(dismissTimers, t.id);
          clearTimer(removeTimers, t.id);
        });
        return {
          ...state,
          toasts: [],
        };
      }
      clearTimer(dismissTimers, action.toastId);
      clearTimer(removeTimers, action.toastId);
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners = [];

let memoryState = { toasts: [] };

function dispatch(action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

/**
 * Shows a toast.
 *
 * `duration` is annotated explicitly rather than inferred. Destructuring it in
 * the signature without a type made tsc infer the parameter as
 * `{ [x: string]: any; duration: any }` — with `duration` REQUIRED — which broke
 * all 20-odd existing `toast({ variant, title, description })` call sites at
 * typecheck. The annotation is also the only place the contract is written down.
 *
 * The index signature is load-bearing, not decoration. Written as a `@param props`
 * plus a `@param props.duration`, tsc reads the type as EXACTLY `{ duration?: number }`
 * and rejects `toast({ variant, title, description })` at all 20-odd call sites as
 * excess properties. The toast object is deliberately open-ended — whatever a
 * caller passes reaches the rendered element — so the type has to say so.
 *
 * @param {{ duration?: number|null, [key: string]: any }} props Toast content:
 *   `title`, `description`, `variant`, `action`, plus anything else that should
 *   reach the rendered element. `duration` is milliseconds on screen before it
 *   starts closing — omit it for the per-variant default, or pass `Infinity`,
 *   `null` or `0` for a toast that stays until the admin closes it. That last one
 *   is right for a failure they must act on and never for a confirmation.
 * @returns {{ id: string, dismiss: () => void, update: (props: object) => void }}
 */
function toast({ duration, ...props }) {
  const id = genId();

  const update = (props) =>
    dispatch({
      type: actionTypes.UPDATE_TOAST,
      toast: { ...props, id },
    });

  const dismiss = () =>
    dispatch({ type: actionTypes.DISMISS_TOAST, toastId: id });

  dispatch({
    type: actionTypes.ADD_TOAST,
    toast: {
      ...props,
      id,
      open: true,
      // Retained as the upstream shadcn contract, and used by nothing in this
      // repo. The visible close button calls `dismiss(id)` from the hook instead,
      // so a caller who passes their own `onOpenChange` cannot accidentally make
      // the X stop working.
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  // `duration` is destructured out of `props` above, so it never reaches the
  // rendered toast object and cannot be spread onto a DOM node as an attribute.
  const ms = duration === undefined
    ? DEFAULT_DURATION_MS[props.variant] ?? DEFAULT_DURATION_MS.default
    : duration;

  if (Number.isFinite(ms) && ms > 0) {
    clearTimer(dismissTimers, id);
    dismissTimers.set(id, setTimeout(dismiss, ms));
  }

  return {
    id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = useState(memoryState);

  useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  return {
    ...state,
    toast,
    dismiss: (toastId) => dispatch({ type: actionTypes.DISMISS_TOAST, toastId }),
  };
}

export { useToast, toast }; 