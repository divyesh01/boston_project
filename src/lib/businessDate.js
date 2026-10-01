export function isBusinessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function validTimezone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return typeof value === 'string' && value.length > 0; }
  catch { return false; }
}

// Civil date arithmetic, independent of the operator's time zone and DST.
export function nextBusinessDate(value) {
  if (!isBusinessDate(value)) throw new Error('Enter a valid current business date.');
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function propertyLocalDate(timezone, instant = new Date()) {
  if (!validTimezone(timezone)) throw new Error('Configure the property time zone first.');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function closeNightAudit(profile) {
  if (!validTimezone(profile.timezone)) throw new Error('Configure the property time zone first.');
  if (profile.night_audit_status === 'RUNNING') throw new Error('Finish the running audit before closing the business date.');
  return { ...profile, current_business_date: nextBusinessDate(profile.current_business_date), night_audit_status: 'OPEN', last_closed_business_date: profile.current_business_date };
}
