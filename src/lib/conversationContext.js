// Conversation context is a convenience default, never an authorization grant.
// The server-side/local function still derives property access from the session.

const EXPLICIT_TIME = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|today|tonight|yesterday|this\s+week|last\s+week|this\s+month|last\s+month|this\s+year|last\s+year|ytd|year-to-date|q[1-4]|quarter\s+[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

export function topicFromQuestion(question) {
  const q = String(question || "").toLowerCase();
  const carried = q.match(/\[conversation topic:\s*([a-z_]+)\]/i);
  if (carried) return carried[1];
  if (/\b(expedia|booking(?:\.com)?|airbnb|ota|channel|direct|walk\s*in)\b/i.test(q)) return "channels";
  if (/\b(refund|chargeback|adjustment)\b/i.test(q)) return "refunds";
  if (/\b(clerk|cash|variance|short|over)\b/i.test(q)) return "cash";
  if (/\b(expense|spend|payroll|labor|cost)\b/i.test(q)) return "expenses";
  if (/\b(occupancy|occupied|vacant|rooms? sold|rooms? available)\b/i.test(q)) return "occupancy";
  if (/\b(profit|money kept|net income|net profit)\b/i.test(q)) return "money_kept";
  if (/\b(revenue|income|money|adr|revpar)\b/i.test(q)) return "revenue";
  return "daily_summary";
}

export function isReferentialFollowUp(question) {
  const q = String(question || "").trim().toLowerCase();
  if (!q || q.length > 90 || hasExplicitTimeReference(q)) return false;
  if (/\b(?:it|this|that|same|there)\b/.test(q)) return true;
  return /^(?:why|why low|why down|what happened|which channel|what should (?:i|we) do|tell me more|more details)[?!., ]*$/.test(q);
}

export function questionWithConversationTopic(question, activeContext, continued) {
  if (!continued || !activeContext?.topic || !isReferentialFollowUp(question)) return question;
  return `${question} [conversation topic: ${activeContext.topic}]`;
}

export function hasExplicitTimeReference(question) {
  return EXPLICIT_TIME.test(String(question || ""));
}

/**
 * Select the date defaults for the next question. An explicit time reference
 * always wins; otherwise the owner can naturally ask "why was it low?" after
 * discussing a confirmed day or range.
 */
export function nextQuestionScope({ question, activeContext, pageProperty, pageDateRange }) {
  const canContinue = activeContext && !hasExplicitTimeReference(question);
  return {
    propertyId: canContinue ? activeContext.propertyId : pageProperty,
    dateFrom: canContinue ? activeContext.from : (pageDateRange?.from || ""),
    dateTo: canContinue ? activeContext.to : (pageDateRange?.to || ""),
    continued: Boolean(canContinue),
  };
}

export function contextFromSummary(summary) {
  const context = summary?.context;
  if (!context?.propertyLabel || !context?.from || !context?.to || context.propertyId == null) return null;
  return context;
}
