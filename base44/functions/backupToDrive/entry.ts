const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import * as crypto from 'node:crypto';
import * as dns from 'node:dns';
import { promisify } from 'node:util';

const dnsLookup = promisify(dns.lookup);

const DRIVE_API = "https://www.googleapis.com/drive/v3";

// Reject URLs targeting local/private networks to prevent SSRF. Covers the
// private ranges the original allowlist missed (CGNAT 100.64/10, 192.0.0/24,
// benchmarking 198.18/15, TEST-NETs) and resolves DNS before connecting to
// blunt DNS-rebinding (TOCTOU) attacks.
function ip4IsPrivate(ip) {
  const parts = String(ip).split('.').map(Number);
  const [a, b, c] = parts;
  if (a === 0) return true;                               // 0.0.0.0/8
  if (a === 10) return true;                              // 10.0.0.0/8
  if (a === 127) return true;                             // 127.0.0.0/8
  if (a === 169 && b === 254) return true;                // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;      // 100.64.0.0/10 (CGNAT)
  if (a === 192 && b === 0) return true;                  // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;   // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true;    // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true;     // 203.0.113.0/24 (TEST-NET-3)
  return false;
}

function ipIsPrivate(ip) {
  if (typeof ip !== 'string') return true;
  const lower = ip.toLowerCase().replace(/[[\]]/g, '');
  // IPv6: loopback (::1, ::), unique-local (fc/fd), link-local (fe8x-febx)
  if (lower.startsWith('::1') || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower)) return true;
  // IPv4-mapped IPv6
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ip4IsPrivate(mapped[1]);
  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) return ip4IsPrivate(lower);
  return false;
}

async function isUrlBlocked(raw) {
  if (typeof raw !== 'string' || !raw) return true;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  const host = url.hostname.toLowerCase();
  // Reserved hostnames
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain') || host.endsWith('.localhost')) return true;
  // IP literal
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[0-9a-f:]+$/i.test(host)) {
    return ipIsPrivate(host);
  }
  // Hostname: resolve and validate every returned address pre-connect.
  try {
    const addresses = await dnsLookup(host, { all: true });
    return addresses.some((a) => ipIsPrivate(a.address));
  } catch {
    return true; // resolution failure -> block
  }
}

async function sanitizeDriveFolder(name) {
  // Drive query strings can't escape single quotes; restrict to safe characters.
  return String(name || "").replace(/[^\w\-. ]/gu, "_").slice(0, 120);
}

async function findOrCreateFolder(accessToken, rawName, parentId) {
  const name = await sanitizeDriveFolder(rawName);
  const query = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listRes = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listData = await listRes.json();
  if (listData.files && listData.files.length > 0) return listData.files[0].id;

  const createRes = await fetch(`${DRIVE_API}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  const createData = await createRes.json();
  return createData.id;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    // Resolve the caller from the session cookie (same as every auth function).
    const cookieHeader = req.headers.get('cookie') || '';
    const cookieMatch = cookieHeader.match(/base44_session=([^;]+)/);
    const token = cookieMatch ? cookieMatch[1] : null;
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
    const session = sessions[0];
    if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await base44.asServiceRole.entities.User.get(session.user_id);
    if (!user || !user.is_active || user.is_locked) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const _csrfHeader = req.headers.get('x-csrf-token');
    const _cookieHeader = req.headers.get('cookie') || '';
    const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
    const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
    if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }


    const body = await req.json();
    const { fileUrl, fileName, propertyName, year, month, reportType, uploadedReportId } = body;
    if (!fileUrl || !fileName) return Response.json({ error: "fileUrl and fileName required" }, { status: 400 });
    if (await isUrlBlocked(fileUrl)) {
      return Response.json({ error: "fileUrl is not an allowed http(s) URL" }, { status: 400 });
    }

    const { accessToken } = await db.asServiceRole.connectors.getConnection("googledrive");

    // Fetch the file content
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return Response.json({ error: "Failed to fetch file" }, { status: 500 });
    const fileBlob = await fileRes.blob();
    const contentType = fileRes.headers.get("content-type") || "application/octet-stream";

    // Create folder structure: Hotel Dashboard Backups → Property → Year → Month → Report Type
    const rootId = await findOrCreateFolder(accessToken, "Hotel Dashboard Backups");
    const propId = await findOrCreateFolder(accessToken, propertyName || "Unknown Property", rootId);
    const yearId = await findOrCreateFolder(accessToken, String(year || new Date().getFullYear()), propId);
    const monthId = await findOrCreateFolder(accessToken, String(month || "All"), yearId);
    const typeId = await findOrCreateFolder(accessToken, String(reportType || "Reports"), monthId);

    // Upload file to the final folder
    const formData = new FormData();
    formData.append("metadata", JSON.stringify({ name: fileName, parents: [typeId] }));
    formData.append("file", fileBlob, fileName);

    const uploadRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      const errMsg = err.error?.message || "Upload failed";

      // Update UploadedReport status to failed
      if (uploadedReportId) {
        await db.entities.UploadedReport.update(uploadedReportId, {
          drive_backup_status: "failed",
        });
      }
      return Response.json({ error: errMsg, status: "failed" }, { status: 500 });
    }

    const uploadData = await uploadRes.json();

    // Update UploadedReport with Drive file ID and backup status
    if (uploadedReportId) {
      await db.entities.UploadedReport.update(uploadedReportId, {
        drive_file_id: uploadData.id,
        drive_backup_status: "backed_up",
      });
    }

    return Response.json({
      drive_file_id: uploadData.id,
      drive_backup_status: "backed_up",
      folder_path: `Hotel Dashboard Backups/${propertyName}/${year}/${month}/${reportType}`,
    });
  } catch (error) {
    return Response.json({ error: error.message, status: "failed" }, { status: 500 });
  }
}