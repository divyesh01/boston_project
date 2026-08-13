export function generateHousekeepingSchedule(checkouts, stayovers) {
  const minutes = (checkouts || 0) * 30 + (stayovers || 0) * 15;
  const staffNeeded = Math.ceil(minutes / 480);
  return {
    requiredMinutes: minutes,
    staffNeeded,
    schedule: `Generate ${staffNeeded} shift(s) for tomorrow.`,
  };
}
