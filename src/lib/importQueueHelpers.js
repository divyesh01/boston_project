// Helper functions for Import queue state, batch calculations, and Force Import confirmations.
//
// Extracted as a low-risk seam to keep Import.jsx maintainable and testable
// without touching parser internals or D1 transaction semantics.

/**
 * Calculates summary metrics for the import queue.
 *
 * @param {Array<Object>} queue
 * @returns {{
 *   queuedCount: number,
 *   readyCount: number,
 *   errorItems: Array<Object>,
 *   doneItems: Array<Object>,
 *   duplicateItems: Array<Object>,
 *   batchImported: number,
 *   batchExcluded: number,
 * }}
 */
export function getQueueMetrics(queue = []) {
  const queuedCount = queue.filter((q) => q.status === 'pending' || q.status === 'scanning').length;
  const readyCount = queue.filter((q) => q.status === 'ready' && q.scan).length;
  const errorItems = queue.filter((q) => q.status === 'error');
  const doneItems = queue.filter((q) => q.status === 'done');
  const duplicateItems = queue.filter((q) => q.status === 'duplicate');

  const batchImported = doneItems.reduce((acc, q) => acc + (Number(q.count) || 0), 0);
  const batchExcluded = doneItems.reduce((acc, q) => acc + (Number(q.excluded) || 0), 0);

  return {
    queuedCount,
    readyCount,
    errorItems,
    doneItems,
    duplicateItems,
    batchImported,
    batchExcluded,
  };
}

/**
 * Confirms deliberate intent before toggling Force Import ON.
 *
 * Normal state is Force Import OFF. Enabling it bypasses duplicate checks
 * and requires explicit owner confirmation identifying the target property.
 *
 * @param {{ propertyName?: string, enabling: boolean, confirmFn?: (msg: string) => boolean }} opts
 * @returns {boolean} True if confirmed or disabling; false if cancelled.
 */
export function confirmForceImportToggle({ propertyName = '', enabling, confirmFn }) {
  if (!enabling) return true;

  const target = propertyName ? `"${propertyName}"` : 'the selected property';
  const message = [
    `Enable Force Import for ${target}?`,
    'WARNING: Force import bypasses duplicate protection and can create duplicate financial records, duplicate revenue, and duplicate transaction entries in reports.',
    'Only use this if you are recovering from a failed import or intentionally re-importing corrected data.',
    'Are you sure you want to enable Force Import?',
  ].join('\n\n');

  const fn = confirmFn || (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm.bind(window) : null);
  if (fn) {
    return Boolean(fn(message));
  }
  return false;
}

/**
 * Confirms batch Force Import execution before processing multiple files.
 *
 * @param {{ propertyName?: string, count: number, confirmFn?: Function }} opts
 * @returns {boolean} True if confirmed; false if cancelled.
 */
export function confirmBatchForceImport({ propertyName = '', count, confirmFn }) {
  const target = propertyName ? `"${propertyName}"` : 'the selected property';
  const message = [
    `You are about to FORCE IMPORT ${count} reports for ${target}.`,
    `This will bypass duplicate detection for ALL ${count} files in this batch.`,
    'Are you sure you want to proceed with this batch force import?',
  ].join('\n\n');

  const fn = confirmFn || (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm.bind(window) : null);
  if (fn) {
    return Boolean(fn(message));
  }
  return false;
}

/**
 * Validates that an item is consistent with the currently active property selection.
 *
 * Guard against:
 * 1. Missing propertyId
 * 2. Property authorization revoked while page was open
 * 3. Scan metadata containing a different property ID than visible selection
 *
 * @param {{
 *   item: Object,
 *   propertyId: string,
 *   accessibleProperties?: Array<{ id: string }>,
 * }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateQueueProperty({ item, propertyId, accessibleProperties = [] }) {
  if (!propertyId || !propertyId.trim()) {
    return { ok: false, error: 'Select a property before importing reports.' };
  }

  if (accessibleProperties.length > 0 && !accessibleProperties.some((p) => p.id === propertyId)) {
    return { ok: false, error: 'Selected property is no longer accessible or authorized.' };
  }

  if (!item?.scan) {
    return { ok: false, error: 'File has not been scanned.' };
  }

  // If scan metadata was recorded with a property ID, enforce that it matches the current property
  const scanPropId = item.scan.meta?.propertyId || item.scan.propertyId;
  if (scanPropId && scanPropId !== propertyId) {
    return {
      ok: false,
      error: `Queue item was scanned for property "${scanPropId}" but current selection is "${propertyId}". Invalidate and re-scan file.`,
    };
  }

  return { ok: true };
}
