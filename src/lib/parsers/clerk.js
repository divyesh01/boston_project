import { detectSections, parseAmount } from "@/lib/csvParser";

const CLERK_SKIP_LABELS = new Set([
  "TOTAL CASH DROPS",
  "CALCULATED DEPOSIT",
  "DUE BACK",
  "CASH OVER / SHORT",
  "PAID OUT",
  "CURRENCY EXCHANGE AMOUNT",
  "GRAND TOTAL",
  "TOTAL",
]);

const DROP_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)\s*-\s*(.+)$/i;

export function scanClerkReport(rawRows, meta, objects = []) {
  const payments = [];
  const drops = [];
  const clerkPayments = [];

  const sections = detectSections(rawRows || []);

  for (let sectionIdx = 0; sectionIdx < sections.length; sectionIdx++) {
    const section = sections[sectionIdx];
    // Create a section identifier from the header row for deduplication
    // This preserves data from each stacked period (month) separately
    const sectionKey = section.headerRow ? section.headerRow.join('|').slice(0, 100) : `section_${sectionIdx}`;

    if (section.type === "payment_summary") {
      for (const row of section.rows) {
        const label = String(row[0] || "").trim();
        if (!label) continue;
        const upper = label.toUpperCase();

        // Drop/shift line: "2026-03-07 03:21 PM - Sunny Shoaib,$481.00,..."
        const m = label.match(DROP_LINE_RE);
        if (m) {
          drops.push({
            record_type: "drop",
            shift_date: m[1],
            clerk_name: m[2],
            amount: parseAmount(row[3]) ?? parseAmount(row[1]) ?? 0,
          });
          continue;
        }

        // Skip audit summary labels (TOTAL CASH DROPS, CURRENCY EXCHANGE AMOUNT, ...)
        if (CLERK_SKIP_LABELS.has(upper)) continue;

        payments.push({
          record_type: "payment",
          payment_type: upper,
          actual: parseAmount(row[1]) ?? 0,
          adjusted: parseAmount(row[2]) ?? 0,
          net_today: parseAmount(row[3]) ?? 0,
          _sectionKey: sectionKey, // Preserve section context for deduplication
        });
      }
    }

    if (section.type === "employee_payments") {
      for (const row of section.rows) {
        const clerkName = String(row[0] || "").trim();
        const payType = String(row[1] || "").trim().toUpperCase();
        const amount = parseAmount(row[2]);
        if (!clerkName || !payType || amount === null) continue;
        clerkPayments.push({
          record_type: "clerk_payment",
          clerk_name: clerkName,
          payment_type: payType,
          amount,
          transaction_count: 1,
          _sectionKey: sectionKey,
        });
      }
    }
  }

  // Fallback for files without detectable stacked headers (e.g. Excel AI extraction)
  if (!sections.length && objects.length) {
    for (const obj of objects) {
      const clerkName = String(obj.clerk_name || obj.username || "").trim();
      const payType = String(obj.payment_type || "").trim().toUpperCase();
      const amount = parseAmount(obj.amount);
      if (clerkName && payType && amount !== null) {
        clerkPayments.push({
          record_type: "clerk_payment",
          clerk_name: clerkName,
          payment_type: payType,
          amount,
          transaction_count: Number(obj.transaction_count) || 1,
        });
        continue;
      }
      const label = String(obj["Payment Type"] || obj.payment_type || obj["Payment Type,Actual,Adjusted,Net Today"] || "").trim();
      const upper = label.toUpperCase();
      const m = label.match(DROP_LINE_RE);
      if (m) {
        drops.push({
          record_type: "drop",
          shift_date: m[1],
          clerk_name: m[2],
          amount: parseAmount(obj.net_today) ?? parseAmount(obj.amount) ?? 0,
        });
      } else if (label && !CLERK_SKIP_LABELS.has(upper)) {
        payments.push({
          record_type: "payment",
          payment_type: upper,
          actual: parseAmount(obj.actual) ?? 0,
          adjusted: parseAmount(obj.adjusted) ?? 0,
          net_today: parseAmount(obj.net_today) ?? 0,
        });
      }
    }
  }

  // Payments repeat per stacked period — preserve each period's data by including
  // the section key in the deduplication key. This prevents earlier months from
  // being silently overwritten by later ones (the "last block wins" bug).
  const seenPayments = new Map();
  for (const p of payments) {
    const key = `${p.payment_type}|${p._sectionKey || 'unknown'}`;
    seenPayments.set(key, p);
  }
  const uniquePayments = [...seenPayments.values()];

  return {
    type: "clerk",
    sections: [
      { name: "Payment Summary", rows: uniquePayments.length, preview: uniquePayments.slice(0, 20) },
      { name: "Deposit Drops", rows: drops.length, preview: drops.slice(0, 20) },
      { name: "Clerk Payments", rows: clerkPayments.length, preview: clerkPayments.slice(0, 20) },
    ],
    totalRows: uniquePayments.length + drops.length + clerkPayments.length,
    payments: uniquePayments,
    drops,
    clerkPayments,
    meta,
  };
}

