import React, { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { DURATION, countUpFrame, parseFormattedNumber, shouldCountUp } from "@/lib/motion";

/**
 * Roll a formatted figure up to its value.
 *
 * The app's one signature motion: big money figures count from 0 on first paint
 * and re-roll whenever the number actually changes, so changing a date range or
 * the credit-card fee rate visibly moves the money rather than silently
 * swapping one string for another.
 *
 * Three guarantees, because these figures are reconciled to the cent:
 *
 *  1. AT REST THE DOM HOLDS THE CALLER'S EXACT STRING. The counter interpolates
 *     inside the *shape* of the formatted value and, on the final frame, prints
 *     `value` itself character-for-character. It can never round $1,020,598.17
 *     to $1,020,598.20 or invent a separator.
 *  2. NO ANIMATION ON AN UNCHANGED RE-RENDER. Filtering, sorting or a parent
 *     re-render that leaves the figure alone leaves the figure alone.
 *  3. `prefers-reduced-motion` SNAPS. No frames, no rAF loop at all.
 *
 * Interrupting mid-roll continues from what is currently on screen rather than
 * restarting at 0, so rapid filter changes read as the number tracking the
 * filter instead of flickering back to zero.
 *
 * @param {string|number|null|undefined} value A pre-formatted figure —
 *   `money(v)`, `money2(v)`, `pct(v)`, `num(v)` — or a raw number. Anything
 *   without exactly one number in it ("—", "3 of 12") is printed unchanged.
 * @param {{ duration?: number, enabled?: boolean }} [options]
 * @returns {string} The string to render this frame.
 */
export function useCountUp(value, options = {}) {
  const { duration = DURATION.count, enabled = true } = options;
  const reduce = useReducedMotion();
  const animate = enabled && !reduce;

  // First paint starts at zero-in-the-same-shape ("$0", "0.0%") so the roll is
  // visible from the very first frame instead of flashing the final value.
  const [display, setDisplay] = useState(() =>
    animate && parseFormattedNumber(value) ? countUpFrame(value, 0, 0) : String(value ?? "")
  );

  // What is currently on screen, as a magnitude. Updated every frame so an
  // interrupted roll resumes from the visible figure.
  const shownRef = useRef(0);
  // The last target this hook has FINISHED rolling to. Keying on completion —
  // rather than on "have I seen this value before" — is what makes a cancelled
  // effect (StrictMode's double-invoke, a fast unmount/remount) restart the
  // roll instead of silently skipping it.
  const settledRef = useRef(/** @type {string|null} */ (null));
  const rafRef = useRef(0);

  useEffect(() => {
    const text = String(value ?? "");

    if (!animate) {
      shownRef.current = parseFormattedNumber(value)?.magnitude ?? 0;
      settledRef.current = text;
      setDisplay(text);
      return;
    }

    // Guarantee 2: already showing this figure, so leave it alone.
    if (settledRef.current === text) return;

    // Changed, but not to something countable ("$0" → "—"): print it rather
    // than leaving a stale number on screen.
    const shape = parseFormattedNumber(value);
    if (!shape || (settledRef.current !== null && !shouldCountUp(settledRef.current, text))) {
      shownRef.current = shape?.magnitude ?? 0;
      settledRef.current = text;
      setDisplay(text);
      return;
    }

    const from = settledRef.current === null ? 0 : shownRef.current;
    if (Math.abs(shape.magnitude - from) < Number.EPSILON) {
      shownRef.current = shape.magnitude;
      settledRef.current = text;
      setDisplay(text);
      return;
    }

    let start = 0;
    const tick = (now) => {
      if (!start) start = now;
      const t = duration <= 0 ? 1 : (now - start) / duration;
      if (t >= 1) {
        shownRef.current = shape.magnitude;
        settledRef.current = text;
        setDisplay(text); // Guarantee 1: the caller's exact string.
        return;
      }
      shownRef.current = from + (shape.magnitude - from) * (1 - Math.pow(1 - t, 3));
      setDisplay(countUpFrame(value, t, from));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [value, animate, duration]);

  return display;
}

/**
 * A figure that counts up to its value.
 *
 * `tabular-nums` is not optional here — without fixed-width digits every frame
 * of the roll is a different width and the number visibly jitters.
 *
 * @param {{ value: string|number, className?: string, duration?: number,
 *   as?: keyof JSX.IntrinsicElements, title?: string }} props
 */
export function CountUp({ value, className = "", duration, as: Tag = "span", title }) {
  const shown = useCountUp(value, duration ? { duration } : undefined);
  return React.createElement(
    Tag,
    {
      className: `tabular-nums ${className}`,
      // The settled value is always in the DOM as a title, so a figure that is
      // mid-roll when someone screenshots or reads it aloud is still resolvable.
      title: title ?? String(value ?? ""),
    },
    shown
  );
}

export default useCountUp;
