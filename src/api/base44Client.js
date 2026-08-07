import localDb from './localDb';

// ─── Helper: match a single row against a Base44-style filter ───
function matchesFilter(row, filter) {
  for (const [key, condition] of Object.entries(filter)) {
    const value = row[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$gte' in condition && value < condition.$gte) return false;
      if ('$lte' in condition && value > condition.$lte) return false;
      if ('$gt' in condition && value <= condition.$gt) return false;
      if ('$lt' in condition && value >= condition.$lt) return false;
      if ('$in' in condition && !condition.$in.includes(value)) return false;
      if ('$ne' in condition && value === condition.$ne) return false;
    } else {
      if (value !== condition) return false;
    }
  }
  return true;
}

// ─── Helper: sort rows by a field (prefix "-" for descending) ───
function sortRows(rows, sortField) {
  if (!sortField) return rows;
  const desc = sortField.startsWith('-');
  const field = desc ? sortField.slice(1) : sortField;
  return [...rows].sort((a, b) => {
    const aVal = a[field] ?? '';
    const bVal = b[field] ?? '';
    if (aVal < bVal) return desc ? 1 : -1;
    if (aVal > bVal) return desc ? -1 : 1;
    return 0;
  });
}

// ─── Create an entity proxy for a Dexie table ───
function createEntityProxy(tableName) {
  const table = localDb[tableName];

  return {
    async filter(query = {}, sortField, limit) {
      let rows = await table.toArray();
      rows = rows.filter(r => matchesFilter(r, query));
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async list(sortField, limit) {
      let rows = await table.toArray();
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async get(id) {
      return await table.get(Number(id) || id);
    },

    async create(data) {
      const now = new Date().toISOString();
      const record = { ...data, created_date: now, updated_date: now };
      const newId = await table.add(record);
      return { ...record, id: newId };
    },

    async update(id, data) {
      const numId = Number(id) || id;
      const now = new Date().toISOString();
      await table.update(numId, { ...data, updated_date: now });
      return await table.get(numId);
    },

    async delete(id) {
      await table.delete(Number(id) || id);
      return { success: true };
    },

    async bulkCreate(dataArray) {
      const now = new Date().toISOString();
      const records = dataArray.map(d => ({ ...d, created_date: now, updated_date: now }));
      await table.bulkAdd(records);
      return records;
    },
  };
}

// ─── Build the entities proxy ───
// Dynamically creates entity accessors for any table name
const entitiesHandler = {
  get(target, tableName) {
    if (target[tableName]) return target[tableName];
    // Check if the table exists in Dexie
    if (localDb[tableName]) {
      target[tableName] = createEntityProxy(tableName);
      return target[tableName];
    }
    // Fallback: return a no-op entity so the app doesn't crash for unknown entities
    console.warn(`[localDb] Unknown entity: ${tableName}`);
    return createEntityProxy(tableName);
  }
};

const entities = new Proxy({}, entitiesHandler);

// ─── Auth: always authenticated locally ───
const LOCAL_USER = {
  id: 'local-admin',
  email: 'admin@localhost',
  full_name: 'Local Admin',
  role: 'admin',
};

const auth = {
  async isAuthenticated() { return true; },
  async me() { return LOCAL_USER; },
  async loginViaEmailPassword() { return LOCAL_USER; },
  async loginWithProvider() { return LOCAL_USER; },
  logout(redirect) {
    if (redirect && typeof redirect === 'string') {
      window.location.href = redirect;
    }
  },
  redirectToLogin(returnUrl) {
    // No-op locally — user is always authenticated
    console.log('[local] redirectToLogin called, ignoring (always authenticated)');
  },
};

// ─── Integrations: local file handling ───
const integrations = {
  Core: {
    async UploadFile({ file }) {
      // Create a blob URL so the CSV parser can fetch() it
      const url = URL.createObjectURL(file);
      // Append the original filename as a hash so isCsvFile() can detect .csv
      const fileUrl = url + '#' + encodeURIComponent(file.name);
      return { file_url: fileUrl };
    },
    async ExtractDataFromUploadedFile({ file_url, json_schema }) {
      // AI extraction not available locally
      return {
        status: 'error',
        details: 'AI data extraction is not available in local mode. Please use CSV files for import.',
        output: [],
      };
    },
  },
};

// ─── Server functions: graceful fallback ───
const functions = {
  async invoke(functionName, params = {}) {
    if (functionName === 'aiAssistant' || functionName === 'query_database') {
      return {
        data: {
          answer: 'The AI Assistant requires a cloud connection to Base44 and is not available in local mode. Your data is fully accessible through the dashboard modules — use the sidebar to navigate between views.',
          summary: null,
        },
      };
    }
    if (functionName === 'generate_data_insights') {
      return {
        data: {
          answer: 'Data insights generation requires a cloud connection. Please review the dashboard charts and KPI cards for your analytics.',
          summary: null,
        },
      };
    }
    if (functionName === 'deleteAccount') {
      // Clear all local data
      await Promise.all(localDb.tables.map(t => t.clear()));
      localStorage.clear();
      return { success: true };
    }
    console.warn(`[local] Unknown function invoked: ${functionName}`);
    return { data: {} };
  },
};

// ─── User management ───
const users = {
  async inviteUser(email, role = 'user') {
    const existing = await localDb.User.where('email').equals(email).first();
    if (existing) return existing;
    const id = await localDb.User.add({
      email,
      role,
      full_name: '',
      created_date: new Date().toISOString(),
    });
    return { id, email, role };
  },
};

// ─── Export the db object matching Base44 SDK interface ───
export const db = {
  auth,
  entities,
  integrations,
  functions,
  users,
};

export const base44 = db;
export default db;