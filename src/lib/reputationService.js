// Guest review & reputation management — pure logic for the review inbox.
//
// Reviews are aggregated from Google, TripAdvisor and OTA sources into one
// inbox. Sentiment is computed with transparent, deterministic rules (a
// positive/negative lexicon plus negation handling) rather than an opaque API,
// so the result is reproducible and testable offline.
//
// Pure and React-free: scripts/probe-reviews.mjs exercises it in Node.

export const REVIEW_SOURCES = ["google", "tripadvisor", "booking", "expedia", "direct"];

export const SOURCE_LABELS = {
  google: "Google",
  tripadvisor: "TripAdvisor",
  booking: "Booking.com",
  expedia: "Expedia",
  direct: "Direct",
  ota: "OTA",
};

export const REVIEW_STATUS = ["new", "replied", "resolved"];

const POSITIVE = [
  "clean", "great", "excellent", "amazing", "wonderful", "comfortable", "friendly",
  "helpful", "quiet", "spacious", "love", "loved", "perfect", "beautiful", "best",
  "fast", "convenient", "value", "impressed", "recommend", "top", "fantastic",
  "welcoming", "spotless", "nice", "good", "enjoyed", "awesome", "delicious",
];
const NEGATIVE = [
  "dirty", "bad", "poor", "terrible", "awful", "noisy", "rude", "broken",
  "cold", "slow", "stale", "disappointed", "disappointing", "worst", "smelly",
  "unhelpful", "uncomfortable", "issue", "problems", "problem", "never again",
  "overpriced", "cancelled", "leak", "mold", "bugs", "unclean", "wait",
];
const NEGATIONS = ["not", "no", "never", "hardly", "barely", "isn't", "wasn't", "don't"];

const STAR_BREAKPOINT = { positive: 4, negative: 2 };

export function scoreSentiment(text) {
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter((t) => t.length > 0);
  let score = 0;
  tokens.forEach((tok, i) => {
    const prev = i > 0 ? tokens[i - 1] : "";
    const negated = NEGATIONS.includes(prev);
    if (POSITIVE.includes(tok)) score += negated ? -1 : 1;
    if (NEGATIVE.includes(tok)) score += negated ? 1 : -1;
  });
  let sentiment = "neutral";
  if (score > 0) sentiment = "positive";
  else if (score < 0) sentiment = "negative";
  return { sentiment, score };
}

// True when the star rating and the text sentiment disagree materially — the
// reviews worth a closer human look.
export function isInconsistent(review) {
  const rating = Number(review.rating) || 3;
  const s = scoreSentiment(review.body || review.text);
  if (rating >= STAR_BREAKPOINT.positive && s.sentiment === "negative") return true;
  if (rating <= STAR_BREAKPOINT.negative && s.sentiment === "positive") return true;
  return false;
}

export function aggregateRating(reviews) {
  const list = reviews || [];
  const rated = list.filter((r) => Number(r.rating) > 0);
  const avg = rated.length ? rated.reduce((a, r) => a + Number(r.rating), 0) / rated.length : 0;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rated) {
    const star = Math.min(5, Math.max(1, Math.round(Number(r.rating))));
    distribution[star] += 1;
  }
  const bySentiment = { positive: 0, neutral: 0, negative: 0 };
  for (const r of list) {
    const s = r.sentiment || scoreSentiment(r.body || r.text).sentiment;
    bySentiment[s] += 1;
  }
  const bySource = {};
  for (const r of list) {
    const k = SOURCE_LABELS[r.source] || r.source || "Other";
    bySource[k] = (bySource[k] || 0) + 1;
  }
  const replied = list.filter((r) => r.status !== "new").length;
  return {
    total: list.length,
    rated: rated.length,
    avg: Math.round(avg * 10) / 10,
    distribution,
    bySentiment,
    bySource,
    replied,
    responseRate: list.length ? replied / list.length : 0,
  };
}

export function needsResponse(reviews) {
  return (reviews || []).filter((r) => r.status === "new");
}