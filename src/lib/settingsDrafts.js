// Durable business-settings drafts. The scope comes from the authenticated
// settings endpoint; never recover drafts using an unconfirmed browser identity.
const PREFIX = 'settings-cloud-draft:v1:';
const validScope = scope => typeof scope === 'string' && /^[a-f0-9]{64}$/.test(scope);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);

export function storeSettingsDraft(scope, entry, revision) {
  if (!validScope(scope)) throw new Error('Load the server settings before saving a recoverable draft.');
  if (!validId(entry.draftId)) throw new Error('Invalid settings draft identity.');
  localStorage.setItem(`${PREFIX}${scope}:${entry.draftId}`, JSON.stringify({
    version: 1, scope, revision, createdAt: entry.createdAt, draft: entry,
  }));
}

export function removeSettingsDraft(scope, entry) {
  if (!validScope(scope) || !validId(entry?.draftId)) return;
  localStorage.removeItem(`${PREFIX}${scope}:${entry.draftId}`);
}

export function readSettingsDrafts(scope, allowedKeys) {
  if (!validScope(scope)) return { drafts: [], unreadable: [] };
  const prefix = `${PREFIX}${scope}:`, records = [], unreadable = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    let record;
    const raw = localStorage.getItem(key);
    try { record = JSON.parse(raw); }
    catch { unreadable.push({ storageKey: key, raw }); continue; }
    const draft = record?.draft;
    if (record?.version !== 1 || record.scope !== scope || !validId(draft?.draftId) ||
        key !== `${prefix}${draft.draftId}` || !allowedKeys.has(draft.key) ||
        typeof draft.propertyId !== 'string' || !draft.propertyId ||
        !Object.prototype.hasOwnProperty.call(draft, 'value') ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        !Number.isFinite(draft.createdAt) ||
        (draft.supersededIds != null && (!Array.isArray(draft.supersededIds) || !draft.supersededIds.every(validId)))) {
      unreadable.push({ storageKey: key, raw });
      continue;
    }
    records.push(draft);
  }
  // Keep every competing draft. The review screen makes the choice explicit.
  return { drafts: records.sort((a, b) => a.createdAt - b.createdAt || a.draftId.localeCompare(b.draftId)), unreadable };
}

export function removeUnreadableSettingsDraft(scope, record) {
  if (!validScope(scope) || !record.storageKey?.startsWith(`${PREFIX}${scope}:`)) throw new Error('Draft scope changed. Review again.');
  if (localStorage.getItem(record.storageKey) !== record.raw) throw new Error('Stored draft changed after review. Review again.');
  localStorage.removeItem(record.storageKey);
}
