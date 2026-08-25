// The Manual Data Entry draft (src/pages/ManualEntry.jsx).
//
// Extracted from the page for the same reason the parser and the writer were
// (src/lib/manualEntryImport.js, src/lib/manualEntrySave.js): the part that can
// lose the operator's hand-typed money rows cannot be probed inside a component's
// effect, and this page's draft is the ONLY copy of those rows until Save lands.
//
// THE DEFECT. The page held five raw localStorage calls and not one of them could
// report a failure to the person typing:
//
//     const saved = localStorage.getItem(key);        // OUTSIDE the try below
//     if (saved) {
//       try { ... } catch (e) { localStorage.removeItem(key); }  // silent discard
//     }
//     try { localStorage.setItem(draftKey, JSON.stringify(rows)); }
//     catch (e) { console.warn("Auto-save failed", e); }          // console only
//     if (draftKey) localStorage.removeItem(draftKey);            // twice, unguarded
//
// Four consequences, all reachable on a browser that refuses storage (private
// browsing, blocked site data) or at quota:
//
//   1. `getItem` sat outside its own try, so a refused read threw out of a
//      useEffect. React re-throws an effect's exception, so the whole page was
//      replaced by App.jsx's LazyErrorBoundary — over a draft nobody had asked
//      to recover.
//   2. A stored draft that parsed but was not a usable list was deleted with no
//      message at all, so hand-typed rows vanished and the grid simply came up
//      empty. CLAUDE.md section 10: "Report errors loudly, not silently."
//   3. The auto-save failure path was a console.warn, while the page went on
//      rendering its amber "● Unsaved draft" dot — the operator was told the rows
//      were being kept at the exact moment they were not.
//   4. The clear after a successful save was unguarded and sits BEFORE
//      setSaving(false) and rotateCsrfToken(), so a refused remove threw past
//      both: the records really were written, and the Save button span forever
//      with a stale CSRF token.
//
// DESIGN RULES, deliberately the same three as src/lib/settingsStore.js so a
// caller cannot reintroduce the silence:
//   * readers NEVER throw — a page must not go blank over a draft;
//   * writers report `ok`, never void, so the page can stop claiming success;
//   * every message names the key AND says what it means for the typed rows,
//     because "auto-save failed" is not actionable and "everything typed here
//     will be lost if this tab closes" is.
//
// WHY NOT settingsStore.js. A draft is not a setting. Its failures have to reach
// the SCREEN — the page routes `problem` into setSaveMsg/setMsgTone, which is why
// every message here is a finished sentence — and a console-only library cannot do
// that. It also needs a guarded remove, which no settings module has ever wanted:
// settings are overwritten, drafts are consumed and deleted.

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

/**
 * The storage key for one property's draft of one report type.
 *
 * `manual_draft_` is a BACKUP PREFIX: `LOCAL_SLOT_PREFIXES` in src/lib/dbArchive.js
 * copies every key matching it into a database export, and probe-db-archive.mjs
 * asserts that. Changing this shape silently drops drafts out of every backup, so
 * re-run that suite if you touch it.
 *
 * @param {string} propertyId
 * @param {string} reportType
 * @returns {string}
 */
export function draftKeyFor(propertyId, reportType) {
  return `manual_draft_${propertyId}_${reportType}`;
}

/**
 * @typedef {Object} DraftRead
 * @property {Array<Object>|null} rows - rows worth offering to recover, else null
 * @property {boolean} discard - the stored value is unusable; the caller should clear the key
 * @property {string} problem - operator-facing sentence, "" when nothing went wrong
 */

/**
 * Reads a saved draft. Never throws.
 *
 * `discard` and `problem` are separate answers, because an empty draft and a
 * corrupt one both have to be removed but only one of them cost the operator
 * anything.
 *
 * @param {string} key
 * @returns {DraftRead}
 */
export function readDraft(key) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch (err) {
    const problem =
      `The saved draft could not be read from browser storage ("${key}": ${describe(err)}), ` +
      `so nothing can be recovered here. Storage may be blocked — private browsing ` +
      `refuses it outright.`;
    console.error(`[manual-draft] ${problem}`);
    // Nothing is known about the stored value, so it must NOT be deleted.
    return { rows: null, discard: false, problem };
  }

  // Absent and empty are not failures: no draft has been saved for this property
  // and report type yet.
  if (raw === null || raw === "") return { rows: null, discard: false, problem: "" };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return unusable(key, `it could not be read back (${describe(err)})`, raw);
  }
  if (!Array.isArray(parsed)) {
    return unusable(key, `it is ${parsed === null ? "empty" : `of type "${typeof parsed}"`}, not a list of rows`, raw);
  }
  // An empty list is not a loss — it is a draft that was cleared, or one stored
  // before a single cell was typed. Remove it and say nothing.
  if (parsed.length === 0) return { rows: null, discard: true, problem: "" };
  if (parsed.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) {
    return unusable(key, "it holds values the grid cannot load as rows", raw);
  }
  return { rows: parsed, discard: false, problem: "" };
}

/**
 * A stored draft was found and cannot be loaded. It is reported as lost rather
 * than quietly dropped, which is what the page did for every one of these cases.
 *
 * @param {string} key
 * @param {string} reason
 * @param {string} raw
 * @returns {DraftRead}
 */
function unusable(key, reason, raw) {
  const problem =
    `The saved draft has been discarded because ${reason} ("${key}"). Any rows it ` +
    `held are gone — re-enter them and save.`;
  console.error(`[manual-draft] ${problem} Stored text: ${echo(raw)}`);
  return { rows: null, discard: true, problem };
}

/**
 * Keeps the typed rows as the draft.
 *
 * @param {string} key
 * @param {Array<Object>} rows
 * @returns {{ok: boolean, problem: string}} `ok` is true only if the rows are now stored
 */
export function writeDraft(key, rows) {
  let text;
  try {
    text = JSON.stringify(rows);
  } catch (err) {
    return failedWrite(
      key,
      `the typed rows could not be converted for storage (${describe(err)}). This is a ` +
        `defect in the calling code, not a storage problem.`
    );
  }
  // JSON.stringify(undefined) returns undefined; storing that would write the
  // text "undefined" and turn the next read into a discarded draft.
  if (text === undefined) {
    return failedWrite(key, "there was nothing storable to keep.");
  }
  try {
    localStorage.setItem(key, text);
    return { ok: true, problem: "" };
  } catch (err) {
    return failedWrite(
      key,
      `browser storage refused it (${describe(err)}) — it may be full, or blocked as it is ` +
        `in private browsing.`
    );
  }
}

/**
 * @param {string} key
 * @param {string} because
 * @returns {{ok: boolean, problem: string}}
 */
function failedWrite(key, because) {
  const problem =
    `The draft is NOT being kept ("${key}"): ${because} Everything typed here will be ` +
    `lost if this tab closes — save it to the database now.`;
  console.error(`[manual-draft] ${problem}`);
  return { ok: false, problem };
}

/**
 * Removes a draft — after it has been saved to the database, or when the operator
 * discards it.
 *
 * @param {string} key
 * @returns {{ok: boolean, problem: string}} `ok` is true only if the key is now gone
 */
export function clearDraft(key) {
  try {
    localStorage.removeItem(key);
    return { ok: true, problem: "" };
  } catch (err) {
    const problem =
      `The draft could not be removed ("${key}": ${describe(err)}), so it will be offered ` +
      `for recovery again the next time this page is opened.`;
    console.error(`[manual-draft] ${problem}`);
    return { ok: false, problem };
  }
}
