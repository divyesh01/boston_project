// Motion tokens and count-up math for the whole app.
//
// ONE source of truth for every duration, easing curve and travel distance, so
// the app reads as a single designed thing instead of the six different timings
// that were previously hand-typed into components (0.2s / 0.4s / 0.6s springs,
// scale 1.02 / 1.03 hovers, ad-hoc staggers).
//
// House style — "restrained premium":
//   • 140–240ms, ease-out. Motion you feel, not motion you watch.
//   • 8–12px of travel. Anything further reads as a slide, not a settle.
//   • opacity and transform ONLY — never width/height/top/left, which force
//     layout and drop frames on the data-dense tables in this app.
//   • one signature moment (the KPI count-up), everything else is quiet.
//
// This file is deliberately dependency-free (no React, no framer-motion) so it
// stays verifiable in plain Node: scripts/verify-motion.mjs imports it directly.
// The matching CSS custom properties live in src/index.css and are asserted
// against the values below by that harness, so the two cannot drift apart.

/** Durations in milliseconds. */
export const DURATION = {
  /** Press feedback — must feel instantaneous. */
  instant: 90,
  /** Hover colour / opacity shifts. */
  fast: 140,
  /** Default: entrances, page transitions, most state changes. */
  base: 190,
  /** Upper bound for anything ambient. Nothing may exceed this except `count`. */
  slow: 240,
  /**
   * The one deliberate exception: rolling a KPI figure up to its value. A
   * counter needs long enough for the eye to read the motion as counting
   * rather than as a flicker, but short enough that the number is legible
   * before the user looks away.
   */
  count: 620,
};

/**
 * Ease-out quart, as a cubic-bezier control-point array for framer-motion.
 * Decisive departure, long gentle settle — the curve that makes short travel
 * feel intentional rather than abrupt.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1];

/** The same curve as a CSS value. Mirrors `--fx-ease` in index.css. */
export const EASE_OUT_CSS = `cubic-bezier(${EASE_OUT.join(", ")})`;

/** Travel distances in pixels. */
export const TRAVEL = {
  /** Nudges: a row settling into a table. */
  sm: 6,
  /** Default entrance rise for cards and page content. */
  base: 10,
  /** Panels and sheets that come from further away. */
  lg: 12,
};

/** Bounds the house style guarantees. The harness asserts these hold. */
export const LIMITS = {
  minDuration: 90,
  maxAmbientDuration: 240,
  minTravel: 6,
  maxTravel: 12,
};

/* ── Easing ──────────────────────────────────────────────────────────────── */

/**
 * Clamp progress into [0, 1].
 *
 * Infinity means "past the end", so it clamps to 1 — a counter handed a runaway
 * timestamp must land on its target, never reset to zero. NaN is the only value
 * treated as 0, because there is no defensible direction to round it towards.
 *
 * @param {number} t
 */
export function clamp01(t) {
  if (Number.isNaN(t) || typeof t !== "number") return 0;
  if (t <= 0) return 0;
  return t >= 1 ? 1 : t;
}

/**
 * Ease-out cubic, used for the count-up.
 *
 * Chosen over the usual easeOutExpo because it is EXACT at both ends:
 * e(0) === 0 and e(1) === 1 with no floating-point residue, so a counter
 * cannot stop one cent short of its target. It is also strictly monotonic,
 * so a figure never ticks backwards on its way up.
 *
 * @param {number} t Progress in [0, 1].
 * @returns {number} Eased progress in [0, 1].
 */
export function easeOutCubic(t) {
  const x = clamp01(t);
  const inv = 1 - x;
  return 1 - inv * inv * inv;
}

/* ── Format-preserving number interpolation ──────────────────────────────── */
//
// Every KPI in this app is handed to the UI ALREADY FORMATTED — `money(v)` →
// "$1,020,598", `money2(v)` → "$1,020,598.17", `pct(v)` → "61.4%",
// `num(v)` → "1,234". Those strings come out of integer-cents math and are
// exact; re-deriving them from a float would risk changing a reported figure,
// which is not a trade this app can make (see BUSINESS.md).
//
// So the counter never rebuilds the final string. It parses the *shape* of the
// formatted value, animates the magnitude inside that shape, and at the end
// hands back the caller's original string character-for-character.

/**
 * The shape of a formatted figure: everything around the number, plus how the
 * number itself is written.
 *
 * @typedef {object} NumberShape
 * @property {string} prefix    Text before the digits — "$", "-$", "≈ ".
 * @property {string} suffix    Text after the digits — "%", "", " days".
 * @property {number} magnitude The absolute value of the number, as a float.
 * @property {number} decimals  Digits after the decimal point, exactly as written.
 * @property {boolean} grouped  Whether thousands separators were present.
 * @property {string} core      The digit run as originally written.
 */

/** Exactly one run of digits, optionally grouped, optionally with decimals. */
const DIGIT_RUN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Read the shape of a formatted figure.
 *
 * Returns null — meaning "do not animate this, just print it" — whenever the
 * value is not a single unambiguous number: no digits at all ("—", "No data"),
 * or two or more numbers in one string ("3 of 12"), where interpolating one and
 * not the other would state something false mid-flight.
 *
 * @param {string|number|null|undefined} value
 * @returns {NumberShape|null}
 */
export function parseFormattedNumber(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    const dot = text.indexOf(".");
    return {
      prefix: value < 0 ? "-" : "",
      suffix: "",
      magnitude: Math.abs(value),
      decimals: dot === -1 ? 0 : text.length - dot - 1,
      grouped: false,
      core: text.replace("-", ""),
    };
  }

  if (typeof value !== "string") return null;

  const runs = value.match(DIGIT_RUN);
  if (!runs || runs.length !== 1) return null;

  const core = runs[0];
  const at = value.indexOf(core);
  const prefix = value.slice(0, at);
  const suffix = value.slice(at + core.length);

  // A digit run may not contain digits after the last comma group in a way
  // that isn't a real number (e.g. "1,2,3"); reject anything that does not
  // parse back cleanly rather than guessing.
  const plain = core.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(plain)) return null;
  const magnitude = Number(plain);
  if (!Number.isFinite(magnitude)) return null;

  const dot = plain.indexOf(".");
  return {
    prefix,
    suffix,
    magnitude,
    decimals: dot === -1 ? 0 : plain.length - dot - 1,
    grouped: core.includes(","),
    core,
  };
}

/**
 * Write a magnitude back out in the same shape it was read in — same decimal
 * count, same grouping, pinned to en-US so a counter never uses different
 * thousands separators than the figure it is counting towards.
 *
 * @param {number} magnitude
 * @param {{ decimals: number, grouped: boolean }} shape
 * @returns {string}
 */
export function formatMagnitude(magnitude, shape) {
  const decimals = Math.max(0, Math.min(20, shape.decimals | 0));
  const n = Number.isFinite(magnitude) ? Math.abs(magnitude) : 0;
  if (!shape.grouped) return n.toFixed(decimals);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * One frame of a count-up.
 *
 * @param {string|number} target       The caller's formatted value — the truth.
 * @param {number} t                   Progress in [0, 1].
 * @param {number} [fromMagnitude]     Magnitude to count from (0 on first paint,
 *                                     the currently displayed figure when a
 *                                     filter change interrupts mid-flight).
 * @returns {string} The string to paint this frame.
 */
export function countUpFrame(target, t, fromMagnitude = 0) {
  const shape = parseFormattedNumber(target);
  // Unparseable, or finished: hand back the caller's exact string. This is the
  // invariant that keeps the counter incapable of misreporting a figure — at
  // rest the DOM holds precisely what the caller passed in.
  if (!shape || clamp01(t) >= 1) return String(target ?? "");

  const eased = easeOutCubic(t);
  const from = Number.isFinite(fromMagnitude) ? Math.abs(fromMagnitude) : 0;
  const value = from + (shape.magnitude - from) * eased;
  return shape.prefix + formatMagnitude(value, shape) + shape.suffix;
}

/**
 * Whether a change in value is worth animating. Guards against re-rolling a
 * figure on an unrelated re-render, and against animating between two strings
 * that differ only in text ("—" → "n/a").
 *
 * @param {string|number|null|undefined} prev
 * @param {string|number|null|undefined} next
 */
export function shouldCountUp(prev, next) {
  if (String(prev ?? "") === String(next ?? "")) return false;
  return parseFormattedNumber(next) !== null;
}

/* ── framer-motion helpers ───────────────────────────────────────────────── */

/**
 * The house entrance: fade up a short distance, ease-out.
 * @param {number} [distance] Travel in px.
 * @param {number} [duration] Duration in ms.
 */
export function fadeRise(distance = TRAVEL.base, duration = DURATION.base) {
  return {
    initial: { opacity: 0, y: distance },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -distance },
    transition: { duration: duration / 1000, ease: EASE_OUT },
  };
}

/**
 * The same entrance with motion stripped out, for `prefers-reduced-motion`.
 * Opacity is kept: a cross-fade carries no vestibular risk and without it
 * page transitions read as a jarring cut.
 * @param {number} [duration]
 */
export function fadeOnly(duration = DURATION.fast) {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: duration / 1000, ease: EASE_OUT },
  };
}

/**
 * Pick the right entrance for the user's motion preference.
 * @param {boolean} reduce
 * @param {number} [distance]
 * @param {number} [duration]
 */
export function entrance(reduce, distance = TRAVEL.base, duration = DURATION.base) {
  return reduce ? fadeOnly() : fadeRise(distance, duration);
}
