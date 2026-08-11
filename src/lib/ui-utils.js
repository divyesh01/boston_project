/**
 * @fileoverview Shared UI component utilities for the RRI Executive design system.
 * 
 * Provides polymorphic component patterns, ref composition, and type-safe
 * prop forwarding utilities used throughout the UI component library.
 * 
 * @module lib/ui-utils
 * @since 2.0.0
 */

import * as React from "react";

/**
 * Compose multiple refs into a single callback ref.
 * 
 * Useful when a component needs to forward a ref while also
 * attaching its own ref internally.
 * 
 * @template T
 * @param {Array<React.Ref<T> | undefined>} refs - Array of refs to compose
 * @returns {(instance: T | null) => void} Callback ref that sets all refs
 * 
 * @example
 * ```jsx
 * const internalRef = useRef(null);
 * const composedRef = composeRefs(ref, internalRef);
 * return <div ref={composedRef} />;
 * ```
 */
export function composeRefs(...refs) {
  return (instance) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(instance);
      } else if (ref != null) {
        ref.current = instance;
      }
    });
  };
}

/**
 * Detect if the current environment is a browser.
 * @returns {boolean} True if running in a browser environment
 */
export function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Detect if the user prefers reduced motion.
 * @returns {boolean} True if user prefers reduced motion
 */
export function prefersReducedMotion() {
  if (!isBrowser()) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Generate a unique ID for accessibility relationships.
 * @param {string} [prefix='id'] - Prefix for the generated ID
 * @returns {string} Unique identifier
 */
export function useUniqueId(prefix = "id") {
  const id = React.useId();
  return `${prefix}-${id.replace(/:/g, "")}`;
}

/**
 * Previous value hook for detecting changes.
 * @template T
 * @param {T} value - Current value
 * @returns {T | undefined} Previous value
 */
export function usePrevious(value) {
  const ref = React.useRef();
  React.useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

/**
 * Hook for detecting component mount status.
 * @returns {() => boolean} Function that returns true if component is mounted
 */
export function useIsMounted() {
  const isMounted = React.useRef(false);
  React.useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  return () => isMounted.current;
}

/**
 * Safe state setter that checks mount status before updating.
 * @template T
 * @returns {[T | undefined, (value: T) => void]} State tuple
 */
export function useSafeState(initialValue) {
  const [state, setState] = React.useState(initialValue);
  const isMounted = useIsMounted();
  
  const setSafeState = React.useCallback((value) => {
    if (isMounted()) {
      setState(value);
    }
  }, [isMounted]);
  
  return [state, setSafeState];
}

/**
 * Hook for keyboard event handling.
 * @param {string} targetKey - Key to listen for
 * @param {() => void} callback - Callback when key is pressed
 * @param {object} [options] - Options
 * @param {boolean} [options.preventDefault] - Whether to prevent default
 */
export function useKeyPress(targetKey, callback, { preventDefault = true } = {}) {
  React.useEffect(() => {
    const handler = (event) => {
      if (event.key === targetKey) {
        if (preventDefault) event.preventDefault();
        callback();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [targetKey, callback, preventDefault]);
}
