import {toCents, fromCents} from './decimal';
const dayKey = row => String(row.property_id ?? '') + ':' + String(row.date || row.shift_date || '').slice(0,10);
const cash = row => String(row.payment_type || '').toUpperCase() === 'CASH';
const amount = row => toCents(row.net_today ?? row.adjusted ?? row.amount ?? 0);
export function reconcileCash(records = []) {
  const groups = new Map();
  for (const row of records) { const key = dayKey(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  let expectedCents = 0, actualCents = 0, electronicCents = 0, complete = groups.size > 0;
  const clerks = [];
  for (const [key, rows] of groups) {
    const receipts = rows.filter(r => r.record_type === 'payment' && cash(r));
    const details = rows.filter(r => r.record_type === 'clerk_payment' && cash(r));
    const drops = rows.filter(r => r.record_type === 'drop');
    const known = receipts.length > 0 || details.length > 0;
    const expected = receipts.length ? receipts.reduce((n,r) => n + amount(r),0) : details.reduce((n,r) => n + amount(r),0);
    complete &&= known;
    expectedCents += expected;
    actualCents += drops.reduce((n,r) => n + toCents(r.amount),0);
    electronicCents += rows.filter(r => r.record_type === 'payment' && !cash(r)).reduce((n,r) => n + amount(r),0);
    const names = new Set([...drops,...details].map(r => r.clerk_name || 'Unknown'));
    for (const clerk of names) {
      const cd = drops.filter(r => (r.clerk_name || 'Unknown') === clerk);
      const cr = details.filter(r => (r.clerk_name || 'Unknown') === clerk);
      const received = cr.length ? cr.reduce((n,r) => n + amount(r),0) : (names.size === 1 && known ? expected : null);
      const deposited = cd.reduce((n,r) => n + toCents(r.amount),0);
      const varianceCents = received === null ? null : received - deposited;
      clerks.push({key:key+':'+clerk,clerk,dropCount:cd.length,last:cd.map(r=>r.shift_date || r.date || '').sort().at(-1)||'',drops:fromCents(deposited),expected:received===null?null:fromCents(received),varianceCents,variance:varianceCents===null?null:fromCents(varianceCents)});
    }
  }
  const varianceCents = complete ? expectedCents - actualCents : null;
  return {complete,expectedCashDrop:complete?fromCents(expectedCents):null,actualCashDrop:fromCents(actualCents),electronicPayments:fromCents(electronicCents),totalShiftActivity:complete?fromCents(expectedCents+electronicCents):null,varianceCents,variance:varianceCents===null?null:fromCents(varianceCents),status:!complete?'Incomplete':varianceCents===0?'Matched':varianceCents>0?'Short':'Over',clerks};
}
