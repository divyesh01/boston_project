const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await db.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const entities = ['OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'ClerkShiftRecord', 'UploadedReport'];
    let deleted = 0;

    for (const entityName of entities) {
      try {
        const records = await db.entities[entityName].list('-created_date', 5000);
        for (const r of records) {
          if (r.created_by_id === user.id) {
            await db.entities[entityName].delete(r.id);
            deleted++;
          }
        }
      } catch (e) {
        // Continue with other entities
      }
    }

    return Response.json({ success: true, recordsDeleted: deleted });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}