import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared mutable test state ────────────────────────────────────────────────
const state = {
  session: { user_id: 'u1', is_revoked: false, expires_at: '2099-01-01T00:00:00Z' },
  user: {
    id: 'u1',
    is_active: true,
    is_locked: false,
    role: 'manager',
    property_access: ['42'],
    permissions: null,
  },
  driveFiles: [
    { id: 'f1', name: 'report1.csv', mimeType: 'text/csv' },
    { id: 'f2', name: 'report2.xlsx', mimeType: 'application/vnd.ms-excel' },
  ],
};

function makeEntities() {
  return {
    Session: { filter: async () => (state.session ? [state.session] : []) },
    User: { get: async () => state.user },
  };
}

const makeClient = () => ({
  asServiceRole: {
    entities: makeEntities(),
    connectors: {
      getConnection: async () => ({ accessToken: 'fake-drive-access-token' }),
    },
  },
});

vi.mock('npm:@base44/sdk@^0.8.41', () => ({ createClientFromRequest: () => makeClient() }));

// Stub global fetch for Google Drive API list endpoint
vi.stubGlobal('fetch', async (url) => {
  if (String(url).startsWith('https://www.googleapis.com/drive/v3/files')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ files: state.driveFiles }),
    };
  }
  throw new Error(`Unexpected fetch to: ${url}`);
});

const handler = (await import('../../base44/functions/listDriveFiles/entry.ts')).default;

function makeReq({ cookie = 'base44_session=mocktoken' } = {}) {
  const map = new Map([['cookie', cookie]]);
  return {
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
  };
}

beforeEach(() => {
  state.session = { user_id: 'u1', is_revoked: false, expires_at: '2099-01-01T00:00:00Z' };
  state.user = {
    id: 'u1',
    is_active: true,
    is_locked: false,
    role: 'manager',
    property_access: ['42'],
    permissions: null,
  };
  state.driveFiles = [
    { id: 'f1', name: 'report1.csv', mimeType: 'text/csv' },
    { id: 'f2', name: 'report2.xlsx', mimeType: 'application/vnd.ms-excel' },
  ];
});

describe('listDriveFiles — authentication and authorization gates', () => {
  describe('Gate 1: Session authentication', () => {
    it('answers 401 when session cookie is missing', async () => {
      const res = await handler(makeReq({ cookie: '' }));
      expect(res.status).toBe(401);
    });

    it('answers 401 when session is revoked', async () => {
      state.session = { ...state.session, is_revoked: true };
      const res = await handler(makeReq());
      expect(res.status).toBe(401);
    });

    it('answers 401 when session is expired', async () => {
      state.session = { ...state.session, expires_at: '2000-01-01T00:00:00Z' };
      const res = await handler(makeReq());
      expect(res.status).toBe(401);
    });

    it('answers 401 when user is inactive or locked', async () => {
      state.user = { ...state.user, is_active: false };
      expect((await handler(makeReq())).status).toBe(401);

      state.user = { ...state.user, is_active: true, is_locked: true };
      expect((await handler(makeReq())).status).toBe(401);
    });
  });

  describe('Gate 2: Permission authorization (import_reports)', () => {
    it('answers 403 for read_only role (cannot import)', async () => {
      state.user = { ...state.user, role: 'read_only' };
      const res = await handler(makeReq());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/import permission required/i);
    });

    it('answers 403 for accountant role (cannot import)', async () => {
      state.user = { ...state.user, role: 'accountant' };
      const res = await handler(makeReq());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/import permission required/i);
    });

    it('answers 403 when permissions.import_reports is explicitly false', async () => {
      state.user = { ...state.user, role: 'manager', permissions: { import_reports: false } };
      const res = await handler(makeReq());
      expect(res.status).toBe(403);
    });
  });

  describe('Gate 3: Property access authorization (fail closed)', () => {
    it('answers 403 when property_access is an empty array', async () => {
      state.user = { ...state.user, role: 'manager', property_access: [] };
      const res = await handler(makeReq());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/no property access assigned/i);
    });

    it('answers 403 when property_access is null or undefined for non-root', async () => {
      state.user = { ...state.user, role: 'manager', property_access: null };
      expect((await handler(makeReq())).status).toBe(403);

      state.user = { ...state.user, role: 'manager', property_access: undefined };
      expect((await handler(makeReq())).status).toBe(403);
    });

    it('answers 403 when property_access is a malformed string or object', async () => {
      state.user = { ...state.user, role: 'manager', property_access: 'some_string' };
      expect((await handler(makeReq())).status).toBe(403);

      state.user = { ...state.user, role: 'manager', property_access: { id: 1 } };
      expect((await handler(makeReq())).status).toBe(403);
    });
  });

  describe('Gate 4: Authorized access', () => {
    it('allows manager with valid property_access array (200)', async () => {
      state.user = { ...state.user, role: 'manager', property_access: ['42'] };
      const res = await handler(makeReq());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.files).toHaveLength(2);
      expect(data.files[0].name).toBe('report1.csv');
    });

    it('allows front_desk with valid property_access array (200)', async () => {
      state.user = { ...state.user, role: 'front_desk', property_access: ['10'] };
      const res = await handler(makeReq());
      expect(res.status).toBe(200);
    });

    it('allows owner even without explicit property_access array (200)', async () => {
      state.user = { ...state.user, role: 'owner', property_access: null };
      const res = await handler(makeReq());
      expect(res.status).toBe(200);
    });

    it('allows admin even without explicit property_access array (200)', async () => {
      state.user = { ...state.user, role: 'admin', property_access: undefined };
      const res = await handler(makeReq());
      expect(res.status).toBe(200);
    });

    it('allows user with property_access === "all" (200)', async () => {
      state.user = { ...state.user, role: 'manager', property_access: 'all' };
      const res = await handler(makeReq());
      expect(res.status).toBe(200);
    });
  });
});
