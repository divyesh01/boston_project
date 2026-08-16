// The audit log is APPEND-ONLY. This endpoint is a hard refusal.
//
// It previously deleted EVERY AuditLog row for any caller with the owner or
// admin role — precisely the accounts an audit trail exists to hold accountable
// — and then appended its own unhashed summary row, which also broke the
// tamper-evident chain that base44/functions/audit_verify checks. Both halves of
// that are disqualifying for a system that records who touched real money: an
// audit trail an insider can erase is not an audit trail, and one that reports
// itself broken after a legitimate action cannot evidence a real intrusion.
//
// Kept as an explicit 403 rather than deleted so a stale client, a bookmarked
// call, or a probing request gets an unambiguous answer instead of a 404 that
// reads like a broken deployment. Nothing in the app calls it any more:
// src/api/base44Client.js no longer exposes db.audit.clear().
//
// If retention ever has to be bounded, it must be done by ARCHIVING, never by
// truncating: export the rows, verify the chain over the export, keep the export
// somewhere append-only, and record the trim itself as a chained audit entry so
// the gap is provable. Deleting rows in place destroys the only evidence that
// they ever existed.
export default async function () {
  return Response.json({
    error: 'The audit log is append-only. Clearing it is not permitted.',
    code: 'append_only',
  }, { status: 403 });
}
