import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    
    // Parse cookies from headers
    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(/base44_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (token) {
    const _csrfHeader = req.headers.get('x-csrf-token');
    const _cookieHeader = req.headers.get('cookie') || '';
    const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
    const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
    if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      
      // Fetch session
      const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
      const session = sessions[0];
      
      if (session && !session.is_revoked) {
        // Mark session as revoked
        await base44.asServiceRole.entities.Session.update(session.id, { is_revoked: true });
      }
    }

    // Clear cookie
    const isProd = process.env.NODE_ENV === 'production' || req.url.startsWith('https');
    const cookie = `base44_session=; HttpOnly; Path=/; SameSite=Lax${isProd ? '; Secure' : ''}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

    return Response.json({ success: true }, {
      headers: {
        'Set-Cookie': cookie
      }
    });

  } catch (err) {
    console.error("Auth logout error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
