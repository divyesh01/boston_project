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
 * Resolves the effective property for an import queue item following strict canonical identity rules:
 *
 * CASE A (Valid snapshot):
 *   Snapshot ID is nonempty AND currently authorized in accessibleProperties.
 *   -> Use snapshot directly (ok: true, source: 'snapshot').
 *
 * CASE B (Authoritative Alias -> Same Canonical Property):
 *   Snapshot ID is nonempty, currently inaccessible, BUT authoritative mapping proves
 *   it is an alias/representation of an accessible canonical property X (e.g. numeric/string
 *   equivalence String(p.id) === String(snapId), or code match p.code === snapCode).
 *   -> Canonicalize to X automatically (ok: true, source: 'authoritative_alias', canonicalized: true).
 *   -> Preserve original snapshot provenance.
 *
 * CASE C (Empty Snapshot):
 *   Snapshot ID is EMPTY (file queued before property chosen) AND:
 *   - selected property is authorized -> use selected property (source: 'selected').
 *   - exactly ONE accessible property exists -> use that canonical property (source: 'canonical_single').
 *   - multiple accessible properties exist -> requiresSelection (ok: false).
 *   - zero accessible properties -> fail closed (ok: false).
 *
 * CASE D (Revoked / Unknown Nonempty Snapshot):
 *   Snapshot ID is NONEMPTY, unauthorized, and NOT authoritatively mapped to any accessible property.
 *   -> NEVER silently re-home it, even if only 1 accessible property exists!
 *   -> If operator has explicitly confirmed reassignment (item.reassignmentConfirmed === true):
 *      proceed with confirmed target (ok: true, source: 'operator_reassigned').
 *   -> Otherwise: require explicit operator reassignment (ok: false, requiresReassignment: true).
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
 *   accessibleProperties?: Array<{ id: string | number, name?: string, code?: string, aliases?: Array<string | number> }>,
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   id: string,
 *   name: string,
 *   error?: string,
 *   source?: 'snapshot' | 'authoritative_alias' | 'operator_reassigned' | 'selected' | 'canonical_single',
 *   reassigned?: boolean,
 *   canonicalized?: boolean,
 *   requiresSelection?: boolean,
 *   requiresReassignment?: boolean,
 *   originalPropertyId?: string,
 *   originalPropertyName?: string,
 *   reassignedFromPropertyId?: string,
 *   suggestedTargetId?: string,
 *   suggestedTargetName?: string,
 * }}
 */
export function resolveQueueProperty({ item, propertyId = '', accessibleProperties = [] }) {
  const snapId = String(item?.propertyId || item?.scan?.meta?.propertyId || item?.scan?.propertyId || '').trim();
  const originalId = String(item?.originalPropertyId || snapId || '').trim();
  const originalName = String(item?.originalPropertyName || item?.propertyName || '').trim();
  const curId = String(propertyId || '').trim();

  // Helper to find authorized property by exact ID or numeric/string ID equivalence
  const findAuthorizedById = (idToFind) => {
    if (!idToFind) return null;
    return accessibleProperties.find((p) => String(p.id) === String(idToFind)) || null;
  };

  // Helper to find authorized property by authoritative code or alias list
  const findAuthoritativeAlias = (idToMatch) => {
    if (!idToMatch) return null;
    const cleanMatch = idToMatch.toLowerCase();
    return accessibleProperties.find((p) => {
      if (p.code && String(p.code).trim().toLowerCase() === cleanMatch) return true;
      if (item?.propertyCode && p.code && String(p.code).trim().toLowerCase() === String(item.propertyCode).trim().toLowerCase()) return true;
      if (item?.scan?.meta?.propertyCode && p.code && String(p.code).trim().toLowerCase() === String(item.scan.meta.propertyCode).trim().toLowerCase()) return true;
      if (Array.isArray(p.aliases) && p.aliases.some((a) => String(a).trim().toLowerCase() === cleanMatch)) return true;
      return false;
    }) || null;
  };

  // -------------------------------------------------------------
  // 1. NONEMPTY SNAPSHOT
  // -------------------------------------------------------------
  if (snapId) {
    // CASE A: Snapshot ID is currently authorized
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

    // CASE B: Authoritative Alias (matches canonical code or explicit aliases)
    const aliasProp = findAuthoritativeAlias(snapId);
    if (aliasProp) {
      return {
        ok: true,
        id: String(aliasProp.id),
        name: String(aliasProp.name || ''),
        source: 'authoritative_alias',
        reassigned: true,
        canonicalized: true,
        originalPropertyId: originalId,
        originalPropertyName: originalName,
      };
    }

    // EXPLICIT CONFIRMATION: Operator previously confirmed reassignment for this item
    if (item?.reassignmentConfirmed === true) {
      const targetProp = findAuthorizedById(curId) || (accessibleProperties.length === 1 ? accessibleProperties[0] : null);
      if (targetProp) {
        return {
          ok: true,
          id: String(targetProp.id),
          name: String(targetProp.name || ''),
          source: 'operator_reassigned',
          reassigned: true,
          reassignedFromPropertyId: item.reassignedFromPropertyId || snapId,
          originalPropertyId: originalId,
          originalPropertyName: originalName,
        };
      }
      if (accessibleProperties.length > 1) {
        return {
          ok: false,
          id: '',
          name: '',
          error: 'Multiple accessible properties available. Please select the target property above to reassign this file.',
          requiresSelection: true,
          originalPropertyId: originalId,
          originalPropertyName: originalName,
        };
      }
    }

    // CASE D: Nonempty snapshot, unauthorized, unmapped, and unconfirmed
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
      error: `Queue item was scanned for "${originalName || originalId}" which is no longer accessible. Explicit operator reassignment is required before importing.`,
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
 * 3. Scan metadata containing a different property ID than visible selection
 *
 * @param {{
 *   item: Object,
 *   propertyId: string,
 *   accessibleProperties?: Array<{ id: string | number, name?: string, code?: string, aliases?: Array<string | number> }>,
 * }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateQueueProperty({ item, propertyId, accessibleProperties = [] }) {
  if (!propertyId || !String(propertyId).trim()) {
    return { ok: false, error: 'Select a property before importing reports.' };
  }

  const pidStr = String(propertyId).trim();
  if (accessibleProperties.length > 0 && !accessibleProperties.some((p) => String(p.id) === pidStr)) {
    return { ok: false, error: 'Selected property is no longer accessible or authorized.' };
  }

  if (!item?.scan) {
    return { ok: false, error: 'File has not been scanned.' };
  }

  // If scan metadata was recorded with a property ID, enforce that it matches the target property
  const scanPropId = item.scan.meta?.propertyId || item.scan.propertyId;
  if (scanPropId && String(scanPropId) !== pidStr) {
    const currentProp = accessibleProperties.find((p) => String(p.id) === pidStr);
    const isCodeMatch = currentProp?.code && String(currentProp.code).trim().toLowerCase() === String(scanPropId).trim().toLowerCase();
    const isAliasMatch = Array.isArray(currentProp?.aliases) && currentProp.aliases.some((a) => String(a).trim().toLowerCase() === String(scanPropId).trim().toLowerCase());
    if (item.reassignmentConfirmed || item.canonicalized || isCodeMatch || isAliasMatch) {
      // Allowed: explicitly confirmed or authoritatively canonicalized
    } else {
      return {
        ok: false,
        error: `Queue item was scanned for property "${scanPropId}" but current selection is "${propertyId}". Invalidate and re-scan file.`,
      };
    }
  }

  return { ok: true };
}

