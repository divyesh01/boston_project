import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  assertSnapshotPropertyIntegrity,
  filterSnapshotForProperties,
  validateAndNormalizeSnapshot,
} from '../shared/accountDataContract.js';

type Principal = {
  access_sub: string;
  account_id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  property_scope_json: string;
  is_active: number;
};

type AccessIdentity = { sub: string; email: string; name: string };
type Snapshot = ReturnType<typeof validateAndNormalizeSnapshot>;

const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const API_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: API_HEADERS });
}

function apiError(message: string, code: string, status: number): Response {
  return json({ success: false, error: message, code }, status);
}

function safeInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function d1BlobBytes(payload: unknown): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Array.isArray(payload) && payload.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return new Uint8Array(payload);
  }
  throw new Error('Authoritative snapshot chunk has an invalid BLOB payload');
}

function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (origin && origin !== new URL(request.url).origin) return false;
  return !fetchSite || ['same-origin', 'none'].includes(fetchSite);
}

async function verifyAccessIdentity(request: Request, env: Env): Promise<AccessIdentity> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) throw Object.assign(new Error('Cloudflare Access assertion is missing'), { status: 401, code: 'ACCESS_REQUIRED' });
  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!payload.sub || !email) {
    throw Object.assign(new Error('Access assertion lacks a stable subject or email'), { status: 401, code: 'ACCESS_CLAIMS_INVALID' });
  }
  return {
    sub: payload.sub,
    email,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : email,
  };
}

async function getOrProvisionPrincipal(identity: AccessIdentity, env: Env): Promise<Principal> {
  let principal = await env.DB.prepare(
    'SELECT access_sub, account_id, email, display_name, role, property_scope_json, is_active FROM principals WHERE access_sub = ?',
  ).bind(identity.sub).first<Principal>();

  if (!principal) {
    const ownerEmail = env.BOOTSTRAP_OWNER_EMAIL.trim().toLowerCase();
    if (identity.email !== ownerEmail) {
      throw Object.assign(new Error('This Access identity has not been assigned to a hotel account'), { status: 403, code: 'PRINCIPAL_NOT_ASSIGNED' });
    }
    const emailOwner = await env.DB.prepare('SELECT access_sub FROM principals WHERE email = ? COLLATE NOCASE')
      .bind(identity.email).first<{ access_sub: string }>();
    if (emailOwner && emailOwner.access_sub !== identity.sub) {
      throw Object.assign(new Error('Owner identity changed; manual re-binding is required'), { status: 403, code: 'OWNER_REBIND_REQUIRED' });
    }
    const accountId = `acct_${(await sha256(identity.email)).slice(0, 24)}`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO accounts (id, display_name, created_at) VALUES (?, ?, ?)')
        .bind(accountId, 'Boston Hotel Account', now),
      env.DB.prepare(`INSERT OR IGNORE INTO principals
        (access_sub, account_id, email, display_name, role, property_scope_json, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'owner', '"all"', 1, ?, ?)`)
        .bind(identity.sub, accountId, identity.email, identity.name, now, now),
    ]);
    principal = await env.DB.prepare(
      'SELECT access_sub, account_id, email, display_name, role, property_scope_json, is_active FROM principals WHERE access_sub = ?',
    ).bind(identity.sub).first<Principal>();
  }
  if (!principal || principal.email.toLowerCase() !== identity.email || principal.is_active !== 1) {
    throw Object.assign(new Error('Account access is disabled or does not match this identity'), { status: 403, code: 'PRINCIPAL_DISABLED' });
  }
  return principal;
}

function principalScope(principal: Principal): 'all' | string[] {
  try {
    const parsed: unknown = JSON.parse(principal.property_scope_json);
    if (parsed === 'all') return 'all';
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) return parsed;
  } catch {
    // Fail closed below.
  }
  throw Object.assign(new Error('Principal property scope is invalid'), { status: 403, code: 'SCOPE_INVALID' });
}

async function readSnapshot(principal: Principal, env: Env): Promise<{ version: number; checksum: string; snapshot: Snapshot } | null> {
  const revision = await env.DB.prepare(`SELECT s.version, r.id, r.checksum, r.chunk_count, r.uncompressed_bytes
    FROM account_snapshots s JOIN snapshot_revisions r ON r.id = s.current_revision_id
    WHERE s.account_id = ?`).bind(principal.account_id)
    .first<{ version: number; id: string; checksum: string; chunk_count: number; uncompressed_bytes: number }>();
  if (!revision) return null;
  const rows = await env.DB.prepare(
    'SELECT chunk_index, payload FROM snapshot_chunks WHERE revision_id = ? ORDER BY chunk_index',
  ).bind(revision.id).all<{ chunk_index: number; payload: unknown }>();
  if (rows.results.length !== revision.chunk_count) throw new Error('Authoritative snapshot is incomplete');
  const chunkPayloads = rows.results.map((row) => d1BlobBytes(row.payload));
  const compressedLength = chunkPayloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  const compressed = new Uint8Array(compressedLength);
  let offset = 0;
  rows.results.forEach((row, index) => {
    if (row.chunk_index !== index) throw new Error('Authoritative snapshot chunk order is invalid');
    compressed.set(chunkPayloads[index], offset);
    offset += chunkPayloads[index].byteLength;
  });
  const decoded = await gunzip(compressed);
  if (decoded.byteLength !== revision.uncompressed_bytes) throw new Error('Authoritative snapshot length mismatch');
  const raw = new TextDecoder().decode(decoded);
  if (await sha256(raw) !== revision.checksum) throw new Error('Authoritative snapshot checksum mismatch');
  const snapshot = validateAndNormalizeSnapshot(JSON.parse(raw));
  assertSnapshotPropertyIntegrity(snapshot);
  return { version: revision.version, checksum: revision.checksum, snapshot };
}

async function buildRevision(snapshot: Snapshot, principal: Principal, env: Env) {
  assertSnapshotPropertyIntegrity(snapshot);
  const raw = JSON.stringify(snapshot);
  const rawBytes = new TextEncoder().encode(raw);
  const maxBytes = safeInt(env.MAX_SNAPSHOT_BYTES, 20_000_000);
  if (rawBytes.byteLength > maxBytes) {
    throw Object.assign(new Error(`Snapshot exceeds ${maxBytes} bytes`), { status: 413, code: 'SNAPSHOT_TOO_LARGE' });
  }
  const compressed = await gzip(rawBytes);
  const chunkBytes = Math.min(safeInt(env.SNAPSHOT_CHUNK_BYTES, 750_000), 1_500_000);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < compressed.byteLength; offset += chunkBytes) {
    chunks.push(compressed.slice(offset, offset + chunkBytes));
  }
  if (!chunks.length) chunks.push(new Uint8Array());
  if (chunks.length > 32) throw Object.assign(new Error('Compressed snapshot requires too many chunks'), { status: 413, code: 'TOO_MANY_CHUNKS' });
  const revisionId = crypto.randomUUID();
  const checksum = await sha256(raw);
  const now = new Date().toISOString();
  return { revisionId, checksum, now, chunks, compressedBytes: compressed.byteLength, uncompressedBytes: rawBytes.byteLength };
}

function revisionInsert(revision: Awaited<ReturnType<typeof buildRevision>>, principal: Principal, env: Env, expectedVersion: number | null) {
  const condition = expectedVersion === null
    ? 'NOT EXISTS (SELECT 1 FROM account_snapshots WHERE account_id = ?)'
    : 'EXISTS (SELECT 1 FROM account_snapshots WHERE account_id = ? AND version = ?)';
  const values = [
    revision.revisionId, principal.account_id, revision.checksum, revision.chunks.length,
    revision.compressedBytes, revision.uncompressedBytes, principal.access_sub, revision.now,
    principal.account_id, ...(expectedVersion === null ? [] : [expectedVersion]),
  ];
  return env.DB.prepare(`INSERT INTO snapshot_revisions
    (id, account_id, checksum, encoding, chunk_count, compressed_bytes, uncompressed_bytes, created_by_sub, created_at)
    SELECT ?, ?, ?, 'gzip-json-v1', ?, ?, ?, ?, ? WHERE ${condition}`).bind(...values);
}

function chunkInserts(revision: Awaited<ReturnType<typeof buildRevision>>, env: Env) {
  return revision.chunks.map((chunk, index) => env.DB.prepare(
    'INSERT INTO snapshot_chunks (revision_id, chunk_index, payload) VALUES (?, ?, ?)',
  ).bind(revision.revisionId, index, chunk));
}

async function bootstrapSnapshot(snapshot: Snapshot, principal: Principal, env: Env) {
  if (principal.role !== 'owner') throw Object.assign(new Error('Only the account owner can bootstrap server data'), { status: 403, code: 'OWNER_REQUIRED' });
  const revision = await buildRevision(snapshot, principal, env);
  try {
    const results = await env.DB.batch([
      revisionInsert(revision, principal, env, null),
      ...chunkInserts(revision, env),
      env.DB.prepare(`INSERT INTO account_snapshots
        (account_id, current_revision_id, version, updated_at) VALUES (?, ?, 1, ?)`)
        .bind(principal.account_id, revision.revisionId, revision.now),
    ]);
    if (results.at(-1)?.meta.changes !== 1) throw new Error('Snapshot pointer was not created');
  } catch (error) {
    const existing = await env.DB.prepare('SELECT version FROM account_snapshots WHERE account_id = ?')
      .bind(principal.account_id).first<{ version: number }>();
    if (!existing) throw error;
    throw Object.assign(new Error('Authoritative data already exists; local data was not uploaded'), { status: 409, code: 'BOOTSTRAP_CONFLICT' });
  }
  return { version: 1, checksum: revision.checksum };
}

async function replaceSnapshot(snapshot: Snapshot, baseVersion: number, principal: Principal, env: Env) {
  if (!['owner', 'admin'].includes(principal.role) || principalScope(principal) !== 'all') {
    throw Object.assign(new Error('Scoped accounts cannot replace the account-wide snapshot'), { status: 403, code: 'ACCOUNT_WRITE_FORBIDDEN' });
  }
  const revision = await buildRevision(snapshot, principal, env);
  try {
    const results = await env.DB.batch([
      revisionInsert(revision, principal, env, baseVersion),
      ...chunkInserts(revision, env),
      env.DB.prepare(`UPDATE account_snapshots
        SET current_revision_id = ?, version = version + 1, updated_at = ?
        WHERE account_id = ? AND version = ?`)
        .bind(revision.revisionId, revision.now, principal.account_id, baseVersion),
    ]);
    if (results.at(-1)?.meta.changes !== 1) throw new Error('Snapshot pointer was not advanced');
  } catch (error) {
    const current = await env.DB.prepare('SELECT version FROM account_snapshots WHERE account_id = ?')
      .bind(principal.account_id).first<{ version: number }>();
    if (current?.version === baseVersion) throw error;
    throw Object.assign(new Error('Server data changed in another browser; nothing was overwritten'), { status: 409, code: 'VERSION_CONFLICT' });
  }
  return { version: baseVersion + 1, checksum: revision.checksum };
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  const maxBytes = safeInt(env.MAX_SNAPSHOT_BYTES, 20_000_000) + 1_000_000;
  if (contentLength > maxBytes) return apiError('Request payload is too large', 'PAYLOAD_TOO_LARGE', 413);

  const identity = await verifyAccessIdentity(request, env);
  const principal = await getOrProvisionPrincipal(identity, env);
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/access/session') {
    if (!sameOriginMutation(request)) return apiError('Cross-origin session request rejected', 'ORIGIN_REJECTED', 403);
    return json({
      success: true,
      user: {
        id: principal.access_sub,
        account_id: principal.account_id,
        email: principal.email,
        full_name: principal.display_name,
        role: principal.role,
        permissions: principal.role === 'owner' ? ['*'] : [],
        property_access: principalScope(principal),
        is_active: true,
      },
    });
  }
  if (request.method !== 'POST' || url.pathname !== '/api/account-data') {
    return apiError('API route not found', 'NOT_FOUND', 404);
  }
  if (!sameOriginMutation(request)) return apiError('Cross-origin mutation rejected', 'ORIGIN_REJECTED', 403);
  const body: unknown = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 'INVALID_BODY', 400);
  const action = 'action' in body && typeof body.action === 'string' ? body.action : '';

  if (action === 'get_authoritative_data') {
    const current = await readSnapshot(principal, env);
    if (!current) return json({ success: true, hasData: false, version: 0 });
    const visible = filterSnapshotForProperties(current.snapshot, principalScope(principal));
    return json({ success: true, hasData: true, version: current.version, checksum: current.checksum, ...visible });
  }
  if (action === 'bootstrap_authoritative_data') {
    if (!('authorized' in body) || body.authorized !== true) return apiError('Explicit owner authorization is required', 'BOOTSTRAP_NOT_AUTHORIZED', 400);
    const snapshot = validateAndNormalizeSnapshot({
      tables: 'tables' in body ? body.tables : null,
      settings: 'settings' in body ? body.settings : null,
    });
    return json({ success: true, ...(await bootstrapSnapshot(snapshot, principal, env)) });
  }
  if (action === 'push_local_data') {
    const baseVersion = 'base_version' in body ? body.base_version : null;
    if (!Number.isSafeInteger(baseVersion) || Number(baseVersion) < 1) return apiError('A valid base_version is required', 'BASE_VERSION_REQUIRED', 400);
    const snapshot = validateAndNormalizeSnapshot({
      tables: 'tables' in body ? body.tables : null,
      settings: 'settings' in body ? body.settings : null,
    });
    return json({ success: true, ...(await replaceSnapshot(snapshot, Number(baseVersion), principal, env)) });
  }
  return apiError('Unknown account-data action', 'UNKNOWN_ACTION', 400);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env);
    } catch (error) {
      const typed = error as Error & { status?: number; code?: string };
      const status = typed.status && typed.status >= 400 && typed.status < 500 ? typed.status : 500;
      console.error(JSON.stringify({
        message: 'account API request failed',
        path: url.pathname,
        status,
        code: typed.code || 'INTERNAL_ERROR',
        error: status === 500 ? typed.message : undefined,
      }));
      return apiError(status === 500 ? 'Internal server error' : typed.message, typed.code || 'INTERNAL_ERROR', status);
    }
  },
} satisfies ExportedHandler<Env>;

// Purely exposes the storage boundary to Worker-runtime tests. It does not add
// an HTTP route or weaken Access verification in deployed code.
export const __test = { bootstrapSnapshot, readSnapshot, replaceSnapshot };
