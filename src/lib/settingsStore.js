// Browser-storage access for the settings modules, with the failures reported.
//
// WHY THIS FILE EXISTS. Nine settings modules each held their own copy of these
// two shapes (measured 2026-08-24):
//
//     try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
//     catch { return { ...DEFAULTS }; }
//
//     try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {}
//     notifySettingsChanged();
//
// Both swallow. The reader replaces the owner's saved configuration with built-in
// defaults and says nothing; the writer discards the save, returns as if it
// worked, and then announces a change that did not happen — so every widget
// re-reads and gets the OLD value while the page shows its "Saved" affordance.
//
// These keys are not cosmetic. They hold the commission rate per booking source,
// the card-processing fee, the fee-on-refunds switch, the tax rate and the
// per-property tax periods, and every net-revenue and tax figure in the app is
// derived from them (hotel.js `commissionFor`, taxConfig.js `calculateTax`). A
// swallowed write therefore means the owner types a negotiated 22% rate, sees no
// error, and the app keeps billing commission at 15% indefinitely. CLAUDE.md
// section 10: "Report errors loudly, not silently."
//
// One module rather than nine corrected copies, because the thing being fixed IS
// the duplication: the answer to "did the write land" now has exactly one
// definition, and the next settings module added to the app gets it for free.
// The four copies of `publicUser()` in this repo are the standing argument for
// why near-identical helpers drift apart.
//
// DESIGN RULES, so a caller cannot reintroduce the silence:
//   • readers NEVER throw — a page must not go blank over a settings key, so a
//     failed read still returns the fallback, it just says so first;
//   • writers return true/false and are never `void` — the boolean is what lets
//     the Settings page stop claiming success;
//   • every message names the key, because "settings failed to save" is not
//     actionable and "rri_tax_config_v1 could not be saved" is;
//   • messages say what it MEANS ("the previous setting is still in effect"),
//     not just what failed. The person reading the console is the hotel owner.

// Long corrupt values are echoed truncated: enough to recognise, not enough to
// flood the console.
const MAX_ECHO = 120;

function describe(err) {
  if (!err) return "unknown error";
  return `${err.name || "Error"}: ${err.message || String(err)}`;
}

function echo(raw) {
  const s = String(raw);
  return s.length > MAX_ECHO ? `${s.slice(0, MAX_ECHO)}… (${s.length} chars total)` : s;
}

function reportFailedRead(key, err) {
  console.error(
    `[settings] could NOT read "${key}" from browser storage (${describe(err)}). ` +
      `Built-in defaults are in effect, so any figure derived from this setting is not ` +
      `using what you configured. Browser storage may be blocked (private browsing).`
  );
}

/**
 * A stored value was found but cannot be used, so defaults were substituted.
 * Exported because some callers can only judge usability themselves — a tax store
 * that parses to an object instead of a list, or a fee that parses to NaN.
 *
 * @param {string} key - the localStorage key, named so the owner can act on it
 * @param {string} reason - what was wrong with the value
 * @param {*} [raw] - the stored text, echoed truncated when supplied
 * @returns {void}
 */
export function reportDiscardedSetting(key, reason, raw) {
  console.error(
    `[settings] the saved value for "${key}" was DISCARDED (${reason}). Built-in ` +
      `defaults are in effect, so any figure derived from this setting is not using ` +
      `what you configured — re-enter it and save.` +
      (raw === undefined ? "" : ` Stored text: ${echo(raw)}`)
  );
}

/**
 * @param {string} key
 * @param {*} err
 * @returns {void}
 */
export function reportFailedWrite(key, err) {
  console.error(
    `[settings] could NOT save "${key}" (${describe(err)}). Nothing was stored, so ` +
      `the previous setting is still in effect and will reappear on reload. Browser ` +
      `storage may be full or blocked (private browsing).`
  );
}

/**
 * Reads a raw string setting. Never throws.
 *
 * @param {string} key
 * @param {*} [fallback] - returned when the key is absent or unreadable
 * @returns {*} the stored string, or `fallback`
 */
export function readRawSetting(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (err) {
    reportFailedRead(key, err);
    return fallback;
  }
}

/**
 * Reads and parses a JSON setting. Never throws. Reports before falling back, so
 * a corrupt store cannot silently revert the owner's configuration.
 *
 * @param {string} key
 * @param {*} fallback - returned when the key is absent, unreadable or unparseable
 * @returns {*} the parsed value, or `fallback`
 */
export function readJsonSetting(key, fallback) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch (err) {
    reportFailedRead(key, err);
    return fallback;
  }
  // Absent and empty are not failures: nothing has been saved yet.
  if (raw === null || raw === "") return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    reportDiscardedSetting(key, describe(err), raw);
    return fallback;
  }
  // Stored "null" parses without error but is not a usable setting. The old
  // spread-based readers folded it into defaults silently; this keeps the same
  // result and says so.
  if (parsed === null) {
    reportDiscardedSetting(key, "stored value was null", raw);
    return fallback;
  }
  return parsed;
}

/**
 * Reads a JSON setting that must be a plain object, so a stored string or array
 * cannot be spread into a config and produce nonsense keys.
 *
 * @param {string} key
 * @param {Object} fallback
 * @returns {Object} the parsed object, or `fallback`
 */
export function readObjectSetting(key, fallback) {
  const parsed = readJsonSetting(key, undefined);
  if (parsed === undefined) return fallback;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    reportDiscardedSetting(key, `expected an object, stored value is ${Array.isArray(parsed) ? "a list" : typeof parsed}`);
    return fallback;
  }
  return parsed;
}

/**
 * Writes a raw string setting.
 *
 * @param {string} key
 * @param {*} value - coerced with String()
 * @returns {boolean} true only if the value is now stored
 */
export function writeRawSetting(key, value) {
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch (err) {
    reportFailedWrite(key, err);
    return false;
  }
}

/**
 * Serialises and writes a setting.
 *
 * @param {string} key
 * @param {*} value
 * @returns {boolean} true only if the value is now stored
 */
export function writeJsonSetting(key, value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    // Distinct from a storage failure: the caller handed over something that
    // cannot be represented (a cycle, a BigInt). Saying "storage is full" here
    // would send the owner to clear their browser over a code defect.
    console.error(
      `[settings] "${key}" could not be converted to JSON (${describe(err)}), so ` +
        `nothing was saved. This is a defect in the calling code, not a storage problem.`
    );
    return false;
  }
  if (text === undefined) {
    console.error(
      `[settings] "${key}" was given a value JSON cannot represent, so nothing was saved.`
    );
    return false;
  }
  return writeRawSetting(key, text);
}
