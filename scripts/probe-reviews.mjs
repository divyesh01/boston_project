// Probe for feature 6 — guest review / reputation logic.
import { scoreSentiment, isInconsistent, aggregateRating, needsResponse } from "../src/lib/reputationService.js";

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok -", msg);
  else { failed += 1; console.error("  FAIL -", msg); }
}

assert(scoreSentiment("Excellent clean room, friendly staff").sentiment === "positive", "positive text scores positive");
assert(scoreSentiment("Dirty bathroom and rude staff").sentiment === "negative", "negative text scores negative");
assert(scoreSentiment("The room is fine.").sentiment === "neutral", "neutral text scores neutral");
assert(scoreSentiment("The room was not dirty at all").sentiment === "positive", "negation reverses sentiment");

assert(isInconsistent({ rating: 5, body: "Terrible, dirty room." }) === true, "high rating + negative text flagged");
assert(isInconsistent({ rating: 2, body: "Excellent stay." }) === true, "low rating + positive text flagged");
assert(isInconsistent({ rating: 5, body: "Great room." }) === false, "consistent not flagged");

const reviews = [
  { source: "google", rating: 5, body: "Great stay, spotless.", status: "new" },
  { source: "booking", rating: 3, body: "Ok.", status: "new" },
  { source: "tripadvisor", rating: 1, body: "Dirty and rude.", status: "replied" },
  { source: "google", rating: 4, body: "Nice.", status: "resolved" },
];
const agg = aggregateRating(reviews.map((r) => ({ ...r, sentiment: scoreSentiment(r.body).sentiment })));
assert(agg.total === 4, "aggregate totals 4 reviews");
assert(agg.avg === 3.3, "avg rating rounds to 3.3 (13/4 rounded to 1 decimal)");
assert(agg.responseRate === 0.5, "response rate is 0.5 (2 of 4 not new)");
assert(agg.bySentiment.positive === 2 && agg.bySentiment.negative === 1, "sentiment distribution correct");
assert(needsResponse(reviews).length === 2, "2 reviews still need a response");

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL REVIEW ASSERTIONS PASSED");
process.exit(failed ? 1 : 0);