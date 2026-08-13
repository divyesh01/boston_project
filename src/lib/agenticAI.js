/**
 * Agentic AI Workflow — RAG pipeline + action proposal.
 * When owner asks: "We are understaffed for holiday weekend".
 * Response: Proposes schedule + asks action consent.
 */
export async function proposeShiftCoverage(query, staffData) {
  const available = staffData.filter(s => s.status === 'available');
  const proposal = available.slice(0, 3).map(s => ({
    employee: s.name,
    shift: 'holiday_weekend',
    hours: 8,
  }));
  return {
    proposal,
    message: 'Should I send SMS requests to available housekeepers?',
    consentRequired: true,
  };
}
