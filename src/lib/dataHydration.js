import localDb from '@/api/localDb';
import { invokeAccountData } from '@/lib/cloudflareApi';
import { queryClientInstance } from '@/lib/query-client';
import { notifySettingsChanged, subscribeSettingsChange } from '@/lib/settingsBus';
import {
  HYDRATION_TABLES,
  HYDRATION_SETTINGS_KEYS,
  HYDRATION_SETTINGS_PREFIXES,
} from '../../shared/accountDataContract.js';

export { HYDRATION_TABLES, HYDRATION_SETTINGS_KEYS };
const CACHE_META_KEY = 'rri_account_cache_meta_v1';
const SYNC_DELAY_MS = 2000;

let state = {
  phase: 'idle',
  isHydrating: false,
  hydrationComplete: false,
  hydrationError: null,
  accountId: null,
  serverVersion: 0,
  serverChecksum: null,
  localSummary: null,
  lastHydratedAt: null,
};
let applyingServerSnapshot = false;
let syncTimer = null;
let syncInFlight = null;
let mutationGeneration = 0;
let listenerCleanup = null;
const subscribers = new Set();

function publish(patch) {
  state = { ...state, ...patch };
  const snapshot = { ...state };
  subscribers.forEach((subscriber) => {
    try {
      subscriber(snapshot);
    } catch (error) {
      console.error('[dataHydration] subscriber failed:', error);
    }
  });
  return snapshot;
}

export function subscribeHydration(callback) {
  subscribers.add(callback);
  callback({ ...state });
  return () => {
    subscribers.delete(callback);
  };
}

export function getHydrationState() {
  return { ...state };
}

function storageKeys() {
  const keys = new Set(HYDRATION_SETTINGS_KEYS);
  if (typeof localStorage === 'undefined') return keys;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && HYDRATION_SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      keys.add(key);
    }
  }
  return keys;
}

function readSettings() {
  const settings = {};
  if (typeof localStorage === 'undefined') return settings;
  for (const key of storageKeys()) {
    const value = localStorage.getItem(key);
    if (value !== null) settings[key] = value;
  }
  return settings;
}

function readCacheMeta() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error('[dataHydration] cache metadata is unreadable:', error);
    return null;
  }
}

function writeCacheMeta(meta) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CACHE_META_KEY, JSON.stringify(meta));
}

export async function exportLocalData() {
  const tables = {};
  for (const tableName of HYDRATION_TABLES) {
    const table = localDb[tableName];
    tables[tableName] = table && typeof table.toArray === 'function'
      ? await table.toArray()
      : [];
  }
  return { tables, settings: readSettings() };
}

export async function summarizeLocalData() {
  const counts = {};
  let rows = 0;
  for (const tableName of HYDRATION_TABLES) {
    const table = localDb[tableName];
    const count = table && typeof table.count === 'function' ? await table.count() : 0;
    counts[tableName] = count;
    rows += count;
  }
  const settings = Object.keys(readSettings()).length;
  return {
    properties: counts.Property || 0,
    reports: counts.UploadedReport || 0,
    rows,
    settings,
    hasData: rows > 0 || settings > 0,
    counts,
  };
}

export async function isLocalDatabaseEmpty() {
  return !(await summarizeLocalData()).hasData;
}

function normalized(value) {
  if (Array.isArray(value)) {
    return value.map(normalized).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
  }
  return value;
}

function snapshotsMatch(local, serverTables, serverSettings) {
  const server = {
    tables: Object.fromEntries(HYDRATION_TABLES.map((name) => [name, serverTables?.[name] || []])),
    settings: serverSettings || {},
  };
  return JSON.stringify(normalized(local)) === JSON.stringify(normalized(server));
}

async function invoke(action, payload = {}) {
  return invokeAccountData(action, payload);
}

export async function importServerData(tables = {}, settings = {}) {
  const cacheTables = HYDRATION_TABLES.map((name) => localDb[name]).filter(Boolean);
  applyingServerSnapshot = true;
  try {
    await localDb.transaction('rw', cacheTables, async () => {
      for (const tableName of HYDRATION_TABLES) {
        const table = localDb[tableName];
        if (!table) continue;
        const rows = Array.isArray(tables[tableName]) ? tables[tableName] : [];
        await table.clear();
        if (rows.length > 0) await table.bulkPut(rows);
      }
    });

    if (typeof localStorage !== 'undefined') {
      const incomingKeys = new Set(Object.keys(settings || {}));
      for (const key of storageKeys()) {
        if (!incomingKeys.has(key)) localStorage.removeItem(key);
      }
      for (const [key, value] of Object.entries(settings || {})) {
        if (value != null) localStorage.setItem(key, String(value));
      }
    }
    notifySettingsChanged();
    await queryClientInstance.invalidateQueries();
  } finally {
    applyingServerSnapshot = false;
  }
}

function markDirty() {
  if (applyingServerSnapshot || !state.accountId) return;
  mutationGeneration += 1;
  const meta = readCacheMeta();
  writeCacheMeta({
    accountId: state.accountId,
    serverVersion: state.serverVersion,
    dirty: true,
  });
  if (state.serverVersion < 1) {
    summarizeLocalData().then((localSummary) => publish({ phase: 'needs-bootstrap', localSummary }));
    return;
  }
  if (meta?.accountId && meta.accountId !== state.accountId) {
    publish({
      phase: 'conflict',
      hydrationError: 'This browser cache belongs to another account and was not uploaded.',
    });
    return;
  }
  scheduleServerSync();
}

export async function pushDataToServer() {
  if (state.serverVersion < 1 || state.phase === 'conflict') return false;
  if (syncInFlight) return syncInFlight;
  const generation = mutationGeneration;
  syncInFlight = (async () => {
    try {
      const { tables, settings } = await exportLocalData();
      const result = await invoke('push_local_data', {
        tables,
        settings,
        base_version: state.serverVersion,
      });
      const stillCurrent = generation === mutationGeneration;
      publish({
        phase: 'ready',
        serverVersion: result.version,
        serverChecksum: result.checksum,
        hydrationError: null,
        lastHydratedAt: new Date().toISOString(),
      });
      writeCacheMeta({ accountId: state.accountId, serverVersion: result.version, dirty: !stillCurrent });
      if (!stillCurrent) scheduleServerSync();
      return true;
    } catch (error) {
      publish({
        phase: error?.code === 'VERSION_CONFLICT' ? 'conflict' : 'error',
        hydrationError: error?.message || String(error),
      });
      return false;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

export function scheduleServerSync(delayMs = SYNC_DELAY_MS) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void pushDataToServer();
  }, delayMs);
}

export async function authorizeServerBootstrap() {
  if (state.phase !== 'needs-bootstrap' || !state.accountId) return false;
  publish({ phase: 'loading', isHydrating: true, hydrationError: null });
  try {
    const { tables, settings } = await exportLocalData();
    const result = await invoke('bootstrap_authoritative_data', {
      authorized: true,
      tables,
      settings,
    });
    writeCacheMeta({ accountId: state.accountId, serverVersion: result.version, dirty: false });
    publish({
      phase: 'ready',
      isHydrating: false,
      hydrationComplete: true,
      serverVersion: result.version,
      serverChecksum: result.checksum,
      lastHydratedAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    publish({ phase: 'error', isHydrating: false, hydrationError: error?.message || String(error) });
    return false;
  }
}

export async function acceptAuthoritativeServerData() {
  if (state.phase !== 'conflict' || !state.accountId) return false;
  return hydrateAccountData({ accountId: state.accountId, force: true, discardLocalCache: true });
}

/**
 * @param {{ accountId?: string, force?: boolean, discardLocalCache?: boolean }} [options]
 */
export async function hydrateAccountData({ accountId, force = false, discardLocalCache = false } = {}) {
  if (!accountId) throw new Error('A stable authenticated account id is required for hydration');
  if (!force && state.accountId === accountId && ['loading', 'ready', 'needs-bootstrap'].includes(state.phase)) {
    return { ...state };
  }

  publish({
    phase: 'loading',
    isHydrating: true,
    hydrationComplete: false,
    hydrationError: null,
    accountId,
  });

  try {
    const localSummary = await summarizeLocalData();
    const server = await invoke('get_authoritative_data');
    if (!server.hasData) {
      if (localSummary.hasData) {
        return publish({
          phase: 'needs-bootstrap',
          isHydrating: false,
          localSummary,
          serverVersion: 0,
        });
      }
      writeCacheMeta({ accountId, serverVersion: 0, dirty: false });
      return publish({
        phase: 'ready',
        isHydrating: false,
        hydrationComplete: true,
        localSummary,
        serverVersion: 0,
        lastHydratedAt: new Date().toISOString(),
      });
    }

    const meta = readCacheMeta();
    if (localSummary.hasData && !discardLocalCache) {
      const local = await exportLocalData();
      const matches = snapshotsMatch(local, server.tables, server.settings);
      const safeOwnedCache = meta?.accountId === accountId && meta?.dirty !== true;
      if (!matches && !safeOwnedCache) {
        return publish({
          phase: 'conflict',
          isHydrating: false,
          hydrationError: 'This browser contains unsynced or differently-owned data. Nothing was overwritten.',
          localSummary,
          serverVersion: server.version,
          serverChecksum: server.checksum,
        });
      }
    }

    await importServerData(server.tables, server.settings);
    writeCacheMeta({ accountId, serverVersion: server.version, dirty: false });
    return publish({
      phase: 'ready',
      isHydrating: false,
      hydrationComplete: true,
      localSummary: await summarizeLocalData(),
      serverVersion: server.version,
      serverChecksum: server.checksum,
      lastHydratedAt: new Date().toISOString(),
    });
  } catch (error) {
    return publish({
      phase: 'error',
      isHydrating: false,
      hydrationComplete: false,
      hydrationError: error?.message || String(error),
    });
  }
}

export function startAccountSync() {
  if (listenerCleanup) return listenerCleanup;
  const hooks = [];
  for (const tableName of HYDRATION_TABLES) {
    const table = localDb[tableName];
    if (!table?.hook) continue;
    for (const eventName of ['creating', 'updating', 'deleting']) {
      const handler = () => markDirty();
      table.hook(eventName, handler);
      hooks.push(() => table.hook[eventName].unsubscribe(handler));
    }
  }
  const unsubscribeSettings = subscribeSettingsChange(() => markDirty());
  const onFocus = () => {
    const meta = readCacheMeta();
    if (state.phase === 'ready' && meta?.dirty !== true && state.accountId) {
      void hydrateAccountData({ accountId: state.accountId, force: true });
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);

  listenerCleanup = () => {
    hooks.forEach((cleanup) => cleanup());
    unsubscribeSettings();
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    listenerCleanup = null;
  };
  return listenerCleanup;
}

export function stopAccountSync() {
  listenerCleanup?.();
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
}

export function resetHydrationForTests() {
  stopAccountSync();
  syncInFlight = null;
  applyingServerSnapshot = false;
  mutationGeneration = 0;
  state = {
    phase: 'idle', isHydrating: false, hydrationComplete: false,
    hydrationError: null, accountId: null, serverVersion: 0,
    serverChecksum: null, localSummary: null, lastHydratedAt: null,
  };
  publish({});
}
