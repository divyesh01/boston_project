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
 * Confirms explicit operator reassignment when a queued file's snapshot property
 * is no longer accessible or authorized.
 *
 * @param {{
 *   oldTarget?: string,
 *   newTarget?: string,
 *   count?: number,
 *   confirmFn?: (msg: string) => boolean,
 * }} opts
 * @returns {boolean} True if confirmed; false if cancelled.
 */
export function confirmPropertyReassignment({
  oldTarget = '',
  newTarget = '',
  count = 1,
  confirmFn,
}) {
  const fileDescriptor = count === 1 ? 'This file was queued for' : `${count} files were queued for`;
  const reassignDescriptor = count === 1 ? 'Reassign this file to' : `Reassign all ${count} queued files to`;

  const message = [
    `${fileDescriptor}:\n${oldTarget || 'Previous property'}`,
    'That property is no longer accessible or authorized.',
    `${reassignDescriptor}:\n${newTarget}?`,
  ].join('\n\n');

  const fn = confirmFn || (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm.bind(window) : null);
  if (fn) {
    return Boolean(fn(message));
  }
  return false;
}

/**
 * Groups queue items requiring reassignment strictly by their immutable origin ID.
 *
 * Prevents batch conflation: ensures mixed batches from multiple properties
 * are never conflated into a single prompt or single property name.
 *
 * @param {Array<Object>} items
 * @returns {Map<string, { originId: string, originName: string, items: Array<Object> }>}
 */
export function groupQueueByOrigin(items = []) {
  const groupsByOrigin = new Map();
  for (const item of items) {
    const originId = String(item.originalPropertyId || item.propertyId || item.scan?.meta?.propertyId || item.scan?.propertyId || '').trim();
    const originName = item.originalPropertyName || item.propertyName || originId || "Previous Property";
    if (!groupsByOrigin.has(originId)) {
      groupsByOrigin.set(originId, { originId, originName, items: [] });
    }
    groupsByOrigin.get(originId).items.push(item);
  }
  return groupsByOrigin;
}

/**
 * Verifies whether an import queue item carries a valid, target-bound reassignment confirmation.
 *
 * A confirmation is valid ONLY when ALL required conditions hold:
 * 1. item.reassignmentConfirmed === true.
 * 2. confirmedFromPropertyId matches the immutable original origin:
 *    String(item.confirmedFromPropertyId) === String(item.originalPropertyId || item.propertyId).
 * 3. confirmedTargetPropertyId exists.
 * 4. If targetPropertyId is provided, confirmedTargetPropertyId matches targetPropertyId:
 *    String(item.confirmedTargetPropertyId) === String(targetPropertyId).
 * 5. confirmedTargetPropertyId is STILL currently authorized in accessibleProperties (unambiguously).
 *
 * If ANY condition is violated, the confirmation is INVALID (grants nothing).
 *
 * @param {{
 *   item?: Object,
 *   targetPropertyId?: string | number,
 *   accessibleProperties?: Array<{ id: string | number, name?: string }>,
 * }} opts
 * @returns {boolean}
 */
export function isValidPropertyReassignmentConfirmation({ item, targetPropertyId, accessibleProperties = [] }) {
  if (!item || item.reassignmentConfirmed !== true) return false;

  const confirmedFrom = String(item.confirmedFromPropertyId || '').trim();
  const confirmedTarget = String(item.confirmedTargetPropertyId || '').trim();
  if (!confirmedFrom || !confirmedTarget) return false;

  // 1. Must match immutable original origin
  const originalOrigin = String(item.originalPropertyId || item.propertyId || item.scan?.meta?.propertyId || item.scan?.propertyId || '').trim();
  if (!originalOrigin || confirmedFrom !== originalOrigin) return false;

  // 2. If a specific target is being evaluated, confirmed target must match it
  if (targetPropertyId !== undefined && targetPropertyId !== null && targetPropertyId !== '') {
    if (confirmedTarget !== String(targetPropertyId).trim()) return false;
  }

  // 3. The confirmed target must STILL be authorized in accessibleProperties (unambiguously)
  const exactTargetMatches = accessibleProperties.filter((p) => String(p.id) === confirmedTarget);
  if (exactTargetMatches.length !== 1) return false;

  return true;
}

/**
 * Resolves the effective property for an import queue item following strict canonical identity rules:
 *
 * CASE A (Valid snapshot):
 *   Snapshot ID is nonempty AND currently authorized in accessibleProperties.
 *   -> Use snapshot directly (ok: true, source: 'snapshot').
 *
 * TARGET-BOUND CONFIRMATION:
 *   If the item carries a valid target-bound confirmation (proven via isValidPropertyReassignmentConfirmation):
 *   -> Proceed with confirmed target (ok: true, source: 'operator_reassigned').
 *
 * CASE C (Empty Snapshot):
 *   Snapshot ID is EMPTY (file queued before property chosen) AND:
 *   - selected property is authorized -> use selected property (source: 'selected').
 *   - exactly ONE accessible property exists -> use that canonical property (source: 'canonical_single').
 *   - multiple accessible properties exist -> requiresSelection (ok: false).
 *   - zero accessible properties -> fail closed (ok: false).
 *
 * CASE D (Revoked / Unknown Nonempty Snapshot):
 *   Snapshot ID is NONEMPTY, unauthorized, and unconfirmed (or confirmation was invalidated).
 *   -> NEVER silently re-home it, even if only 1 accessible property exists!
 *   -> Require explicit operator reassignment (ok: false, requiresReassignment: true).
 *
 * CASE E (Multiple Accessible Properties):
 *   Requires selection when target is ambiguous.
 *
 * CASE F (Zero Accessible Properties):
 *   Fails closed.
 *
 * @param {{
 *   item?: Object,
 *   propertyId?: string,
 *   accessibleProperties?: Array<{ id: string | number, name?: string }>,
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   id: string,
 *   name: string,
 *   error?: string,
 *   source?: 'snapshot' | 'operator_reassigned' | 'selected' | 'canonical_single',
 *   reassigned?: boolean,
 *   requiresSelection?: boolean,
 *   requiresReassignment?: boolean,
 *   originalPropertyId?: string,
 *   originalPropertyName?: string,
 *   confirmedFromPropertyId?: string,
 *   confirmedTargetPropertyId?: string,
 *   suggestedTargetId?: string,
 *   suggestedTargetName?: string,
 * }}
 */
export function resolveQueueProperty({ item, propertyId = '', accessibleProperties = [] }) {
  const snapId = String(item?.propertyId || item?.scan?.meta?.propertyId || item?.scan?.propertyId || '').trim();
  const originalId = String(item?.originalPropertyId || snapId || '').trim();
  const originalName = String(item?.originalPropertyName || item?.propertyName || '').trim();
  const curId = String(propertyId || '').trim();

  // Helper to find authorized property by exact ID or unambiguous numeric/string representation
  const findAuthorizedById = (idToFind) => {
    if (idToFind === null || idToFind === undefined || idToFind === '') return null;
    const stringMatches = accessibleProperties.filter((p) => String(p.id) === String(idToFind));
    // If more than one property matches String(id), it is an ambiguous collision! Fail closed.
    if (stringMatches.length === 1) return stringMatches[0];
    return null; // 0 matches or >1 ambiguous collision!
  };

  // Fail closed if zero accessible properties exist
  if (accessibleProperties.length === 0) {
    return {
      ok: false,
      id: '',
      name: '',
      error: 'No accessible properties found. Contact your administrator for access.',
    };
  }

  // -------------------------------------------------------------
  // 1. NONEMPTY SNAPSHOT
  // -------------------------------------------------------------
  if (snapId) {
    // 1. TARGET-BOUND OPERATOR CONFIRMATION:
    // If the item carries a target-bound confirmation:
    // - If current selection changed since confirmation, prior approval is INVALIDATED!
    // - If confirmed target is still authorized and matches target, proceed as operator_reassigned.
    // - If confirmed target is revoked, prior approval is INVALIDATED and fails closed!
    if (item?.confirmedTargetPropertyId) {
      if (curId && String(item.confirmedTargetPropertyId).trim() !== curId) {
        const suggestedTarget = findAuthorizedById(curId);
        return {
          ok: false,
          id: '',
          name: '',
          requiresReassignment: true,
          originalPropertyId: originalId,
          originalPropertyName: originalName,
          suggestedTargetId: suggestedTarget ? String(suggestedTarget.id) : '',
          suggestedTargetName: suggestedTarget ? String(suggestedTarget.name || '') : '',
          error: `Queue item was previously confirmed for a different property (${item.confirmedTargetPropertyId}). New operator confirmation is required for "${suggestedTarget?.name || curId}".`,
        };
      }

      const isConfirmedValid = isValidPropertyReassignmentConfirmation({
        item,
        targetPropertyId: item.confirmedTargetPropertyId,
        accessibleProperties,
      });
      if (isConfirmedValid) {
        const targetProp = findAuthorizedById(item.confirmedTargetPropertyId);
        if (targetProp) {
          return {
            ok: true,
            id: String(targetProp.id),
            name: String(targetProp.name || item?.propertyName || ''),
            source: 'operator_reassigned',
            reassigned: true,
            originalPropertyId: originalId,
            originalPropertyName: originalName,
            confirmedFromPropertyId: String(item.confirmedFromPropertyId),
            confirmedTargetPropertyId: String(item.confirmedTargetPropertyId),
          };
        }
      }

      // If confirmed target was revoked or confirmation is invalid, fail closed
      const suggestedTarget = findAuthorizedById(curId) || (accessibleProperties.length === 1 ? accessibleProperties[0] : null);
      return {
        ok: false,
        id: '',
        name: '',
        requiresReassignment: true,
        originalPropertyId: originalId,
        originalPropertyName: originalName,
        suggestedTargetId: suggestedTarget ? String(suggestedTarget.id) : '',
        suggestedTargetName: suggestedTarget ? String(suggestedTarget.name || '') : '',
        error: `Confirmed target property is no longer accessible or authorized. Explicit operator reassignment is required before importing.`,
      };
    }

    // CASE A: Direct Snapshot ID is currently authorized (not reassigned)
    const directProp = findAuthorizedById(snapId);
    if (directProp) {
      return {
        ok: true,
        id: String(directProp.id),
        name: String(item?.propertyName || directProp.name || ''),
        source: 'snapshot',
        reassigned: false,
        originalPropertyId: originalId,
        originalPropertyName: originalName,
      };
    }

    // CASE D: Nonempty snapshot, unauthorized, unconfirmed (or previous confirmation invalidated)
    // NEVER silently re-home, even if exactly 1 accessible property exists!
    if (accessibleProperties.length === 0) {
      return {
        ok: false,
        id: '',
        name: '',
        error: 'No accessible properties found. Contact your administrator for access.',
      };
    }

    if (accessibleProperties.length > 1 && !curId) {
      return {
        ok: false,
        id: '',
        name: '',
        requiresReassignment: true,
        requiresSelection: true,
        originalPropertyId: originalId,
        originalPropertyName: originalName,
        error: 'Multiple accessible properties available. Please select the target property above to reassign this file.',
      };
    }

    const suggestedTarget = findAuthorizedById(curId) || (accessibleProperties.length === 1 ? accessibleProperties[0] : null);
    return {
      ok: false,
      id: '',
      name: '',
      requiresReassignment: true,
      originalPropertyId: originalId,
      originalPropertyName: originalName,
      suggestedTargetId: suggestedTarget ? String(suggestedTarget.id) : '',
      suggestedTargetName: suggestedTarget ? String(suggestedTarget.name || '') : '',
      error: `Queue item was queued for "${originalName || originalId}" which is no longer accessible. Explicit operator reassignment is required before importing.`,
    };
  }

  // -------------------------------------------------------------
  // 2. EMPTY SNAPSHOT (file queued before property was selected, or called without an item)
  // -------------------------------------------------------------
  // Check currently selected property in dropdown
  if (curId) {
    const curProp = findAuthorizedById(curId);
    if (curProp) {
      return {
        ok: true,
        id: String(curProp.id),
        name: String(curProp.name || ''),
        source: 'selected',
        reassigned: false,
      };
    }
  }

  // CASE C: Exactly ONE accessible property -> Safe single-property fallback
  if (accessibleProperties.length === 1) {
    return {
      ok: true,
      id: String(accessibleProperties[0].id),
      name: String(accessibleProperties[0].name || ''),
      source: 'canonical_single',
      reassigned: false,
    };
  }

  // CASE E: Multiple accessible properties
  if (accessibleProperties.length > 1) {
    return {
      ok: false,
      id: '',
      name: '',
      error: 'Multiple accessible properties available. Please select the target property above to reassign this file.',
      requiresSelection: true,
    };
  }

  // CASE F: Zero accessible properties
  return {
    ok: false,
    id: '',
    name: '',
    error: 'No accessible properties found. Contact your administrator for access.',
  };
}

/**
 * Validates that an item is consistent with the currently active property selection.
 *
 * Guard against:
 * 1. Missing propertyId
 * 2. Property authorization revoked while page was open
 * 3. Scan metadata containing a different property ID than visible selection without
 *    a valid target-bound operator confirmation.
 *
 * @param {{
 *   item: Object,
 *   propertyId: string,
 *   accessibleProperties?: Array<{ id: string | number, name?: string }>,
 * }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateQueueProperty({ item, propertyId, accessibleProperties = [] }) {
  if (!propertyId || !String(propertyId).trim()) {
    return { ok: false, error: 'Select a property before importing reports.' };
  }

  const pidStr = String(propertyId).trim();
  const currentProp = accessibleProperties.find((p) => String(p.id) === pidStr);
  if (!currentProp) {
    return { ok: false, error: 'Selected property is no longer accessible or authorized.' };
  }

  if (!item?.scan) {
    return { ok: false, error: 'File has not been scanned.' };
  }

  // If scan metadata was recorded with a property ID, enforce that it matches the target property
  const scanPropId = item.scan.meta?.propertyId || item.scan.propertyId;
  if (scanPropId && String(scanPropId) !== pidStr) {
    // Scan metadata was for a different property than the target propertyId.
    // This is ONLY permitted if there is a valid, target-bound confirmation:
    const validConfirmation = isValidPropertyReassignmentConfirmation({
      item,
      targetPropertyId: pidStr,
      accessibleProperties,
    });
    if (!validConfirmation) {
      return {
        ok: false,
        error: `Queue item was scanned for property "${scanPropId}" but target property is "${propertyId}". Reassignment confirmation is invalid or required.`,
      };
    }
  }

  return { ok: true };
}

