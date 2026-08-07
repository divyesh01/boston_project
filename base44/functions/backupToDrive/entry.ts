const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const DRIVE_API = "https://www.googleapis.com/drive/v3";

async function findOrCreateFolder(accessToken, name, parentId) {
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
    const user = await db.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { fileUrl, fileName, propertyName, year, month, reportType, uploadedReportId } = body;
    if (!fileUrl || !fileName) return Response.json({ error: "fileUrl and fileName required" }, { status: 400 });

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