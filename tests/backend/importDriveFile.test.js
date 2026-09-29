// Tests for the property_access fail-closed fix in
// base44/functions/importDriveFile/entry.ts.
//
// THE DEFECT (line 60, before fix):
//   const allowedPropertyIds =
//     user.property_access === 'all' || !Array.isArray(user.property_access)
//       ? null
//       : user.property_access.map(String);
//
// `!Array.isArray(user.property_access)` is true for undefined, null, any
// non-array value — so a user with a missing or malformed property_access
// silently became unrestricted (null = bypass all checks). This test file
// pins the three categories the requirement specifies:
//
//   1. no grant          — property_access missing/null/undefined → 403
//   2. another property  — array grant that does NOT include the requested id → 403
//   3. allowed property  — array grant that includes the requested id → passes auth
//
// The tests also cover the three explicit bypass paths (owner, admin,
// property_access === 'all') to prove authorized access still works.
//
// Architecture note: the function makes two network calls that must be
// stubbed — a Drive fetch (googleapis.com) and a base44 UploadFile call.
// Both are stubbed at the global fetch level and via the SDK mock.  No real
// credentials or production data are used.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── shared mutable state ────────────────────────────────────────────────────

const state = {
  session: { user_id: 'u1', is_revoked: false, expires_at: '2099-01-01T00:00:00Z' },
  user: {
    id: 'u1', is_active: true, is_locked: false,
    role: 'manager', property_access: ['42'],
  },
  report: null, // set per-test for uploadedReportId paths
};

function makeEntities() {
  return {
    Session: { filter: async () => (state.session ? [state.session] : []) },
    User:    { get: async () => state.user },
    UploadedReport: {
      get: async (id) => {
        if (state.report && String(state.report.id) === String(id)) return state.report;
        return null;
      },
    },
  };
}

const makeClient = () => ({
  asServiceRole: {
    entities: makeEntities(),
    connectors: {
      getConnection: async () => ({ accessToken: 'fake-access-token' }),
    },
  },
  integrations: {
    Core: {
      UploadFile: async () => ({ file_url: 'https://storage.example.com/fake.csv' }),
    },
  },
});

// ─── vitest module mocks ─────────────────────────────────────────────────────

vi.mock('npm:@base44/sdk@^0.8.41', () => ({ createClientFromRequest: () => makeClient() }));
vi.mock('npm:zod', async () => await import('zod'));

// Stub global fetch: simulate a small valid CSV file coming back from Drive.
// Tests that should 403 before the Drive fetch never reach this stub.
const FAKE_CSV = new Blob(['id,amount\n1,100\n'], { type: 'text/csv' });
vi.stubGlobal('fetch', async (url) => {
  if (String(url).startsWith('https://www.googleapis.com/drive/v3/files/')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/csv' },
      blob: async () => FAKE_CSV,
      json: async () => ({}),
    };
  }
  throw new Error(`Unexpected fetch to: ${url}`);
});

// ─── lazy-import after mocks ─────────────────────────────────────────────────

const handler = (await import('../../base44/functions/importDriveFile/entry.ts')).default;

// ─── request builder ─────────────────────────────────────────────────────────

const CSRF = 'test-csrf-token';

function makeReq({ body = {}, cookie, csrf = CSRF } = {}) {
  const cookieVal = cookie ?? `base44_session=mocktoken; __Host-csrf_token=${CSRF}`;
  const map = new Map([
    ['cookie', cookieVal],
    ['x-csrf-token', csrf],
  ]);
  return {
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    json: async () => (typeof body === 'function' ? body() : body),
  };
}

// ─── test reset ──────────────────────────────────────────────────────────────

beforeEach(() => {
  state.session = { user_id: 'u1', is_revoked: false, expires_at: '2099-01-01T00:00:00Z' };
  state.user = {
    id: 'u1', is_active: true, is_locked: false,
    role: 'manager', property_access: ['42'],
  };
  state.report = null;
});

// ─── GROUP 1: no grant — missing / malformed property_access → fail closed ───

describe('property_access: no grant → fail closed (403)', () => {
  // Each sub-case uses a different malformed value to prove the old bug
  // (`!Array.isArray(x)` → unrestricted) is gone.

  it('property_access undefined → 403 when a property check is required', async () => {
    state.user = { ...state.user, role: 'front_desk', property_access: undefined };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99' } }));
    expect(res.status).toBe(403);
    const body = await res.json();
    // Must refuse, not fall through to a 500 or 200
    expect(body.error).toMatch(/forbidden|not authorized/i);
  });

  it('property_access null → 403 when a property check is required', async () => {
    state.user = { ...state.user, role: 'front_desk', property_access: null };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99' } }));
    expect(res.status).toBe(403);
  });

  it('property_access is an unexpected string (not "all") → 403', async () => {
    // e.g. a corrupted value like "manager" or "true"
    state.user = { ...state.user, role: 'manager', property_access: 'some-string' };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99' } }));
    expect(res.status).toBe(403);
  });

  it('property_access is a plain object (not an array) → 403', async () => {
    state.user = { ...state.user, role: 'manager', property_access: { id: '99' } };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99' } }));
    expect(res.status).toBe(403);
  });

  it('no propertyId and no uploadedReportId → 400 (authorization context required)', async () => {
    // Regardless of property_access value, missing both context fields → 400.
    state.user = { ...state.user, role: 'manager', property_access: undefined };
    const res = await handler(makeReq({ body: { fileId: 'file1' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/authorization context required/i);
  });

  it('uploadedReportId for a property the user has no grant for → 403', async () => {
    state.user = { ...state.user, role: 'front_desk', property_access: null };
    state.report = { id: 'r1', property_id: '99', drive_file_id: 'file1' };
    const res = await handler(makeReq({ body: { fileId: 'file1', uploadedReportId: 'r1' } }));
    // property_access: null is not a grant — the user cannot access property 99
    expect(res.status).toBe(403);
  });
});

// ─── GROUP 2: another property — array grant excludes the requested id ────────

describe('property_access: scoped array that excludes the requested property → 403', () => {
  it('propertyId path: grant is [42], request targets property 99 → 403', async () => {
    state.user = { ...state.user, role: 'manager', property_access: ['42'] };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not authorized for this property/i);
  });

  it('propertyId path: numeric grant [42], request targets string "99" → 403', async () => {
    // Ensures the String(id) coercion works in the negative case too.
    state.user = { ...state.user, role: 'manager', property_access: [42] };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: 99 } }));
    // 99 is not in [42]
    expect(res.status).toBe(403);
  });

  it('uploadedReportId path: report belongs to property 99, grant is [42] → 403', async () => {
    state.user = { ...state.user, role: 'manager', property_access: ['42'] };
    state.report = { id: 'r1', property_id: '99', drive_file_id: 'file1' };
    const res = await handler(makeReq({ body: { fileId: 'file1', uploadedReportId: 'r1' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not authorized for this report/i);
  });

  it('uploadedReportId path: fileId mismatch even with a valid property grant → 403', async () => {
    // The report's drive_file_id doesn't match the requested fileId.
    state.user = { ...state.user, role: 'manager', property_access: ['42'] };
    state.report = { id: 'r1', property_id: '42', drive_file_id: 'DIFFERENT_FILE' };
    const res = await handler(makeReq({ body: { fileId: 'file1', uploadedReportId: 'r1' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/fileId does not match/i);
  });
});

// ─── GROUP 3: allowed access — grant includes the property, or bypass applies ─

describe('property_access: authorized access passes the property check', () => {
  it('array grant includes the requested propertyId → proceeds past auth (200)', async () => {
    state.user = { ...state.user, role: 'manager', property_access: ['42'] };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '42' } }));
    // Auth passes; Drive + upload succeed via stubs → 200
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.file_url).toBe('https://storage.example.com/fake.csv');
  });

  it('array grant with numeric id matches string propertyId → 200', async () => {
    state.user = { ...state.user, role: 'manager', property_access: [42] };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '42' } }));
    expect(res.status).toBe(200);
  });

  it('uploadedReportId for a property the user is granted → 200', async () => {
    state.user = { ...state.user, role: 'manager', property_access: ['42'] };
    state.report = { id: 'r1', property_id: '42', drive_file_id: 'file1' };
    const res = await handler(makeReq({ body: { fileId: 'file1', uploadedReportId: 'r1' } }));
    expect(res.status).toBe(200);
  });

  it('property_access === "all" → unrestricted (null allowlist) → any property passes', async () => {
    state.user = { ...state.user, role: 'manager', property_access: 'all' };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99999' } }));
    expect(res.status).toBe(200);
  });

  it('role === "admin" with no explicit property grant → unrestricted → 200', async () => {
    // admin role bypasses property checks regardless of property_access value
    state.user = { ...state.user, role: 'admin', property_access: undefined };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99999' } }));
    expect(res.status).toBe(200);
  });

  it('role === "owner" with no explicit property grant → unrestricted → 200', async () => {
    state.user = { ...state.user, role: 'owner', property_access: null };
    const res = await handler(makeReq({ body: { fileId: 'file1', propertyId: '99999' } }));
    expect(res.status).toBe(200);
  });
});
