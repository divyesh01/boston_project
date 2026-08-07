const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await db.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const fileId = body.fileId;
    const fileName = body.fileName || fileId;
    if (!fileId) return Response.json({ error: 'fileId required' }, { status: 400 });

    const { accessToken } = await db.asServiceRole.connectors.getConnection("googledrive");

    const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!driveRes.ok) {
      const err = await driveRes.json().catch(() => ({}));
      return Response.json({ error: err.error?.message || "Failed to download file" }, { status: driveRes.status });
    }

    const blob = await driveRes.blob();
    const contentType = driveRes.headers.get("content-type") || "application/octet-stream";
    const file = new File([blob], fileName, { type: contentType });
    const { file_url } = await db.integrations.Core.UploadFile({ file });

    return Response.json({ file_url, fileName });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}