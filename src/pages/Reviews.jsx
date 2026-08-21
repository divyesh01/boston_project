import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
} from "recharts";
import Card from "@/components/ui-exec/Card";
import PieDonut from "@/components/charts/PieDonut";
import { useReviews } from "@/lib/useHotelData";
import { num, pct } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { useRealtimeInvalidation } from "@/lib/realtime";
import {
  SOURCE_LABELS, scoreSentiment, isInconsistent, aggregateRating, needsResponse,
} from "@/lib/reputationService";
import { ErrorState } from "@/components/ui/status";

const SENTIMENT_COLOR = { positive: "#00E096", neutral: "#FFB547", negative: "#FF6B6B" };
const CHART_COLORS = ["#6C63FF", "#00D4FF", "#00E096", "#FFB547", "#FF6B6B"];

export default function Reviews() {
  const { dateRange, property } = useGlobalFilters();
  const queryClient = useQueryClient();
  useRealtimeInvalidation(["reviews"]);

  const reviewsQ = useReviews(dateRange, property);
  const { data: reviews = [], isLoading } = reviewsQ;

  const [replyId, setReplyId] = useState(null);
  const [draft, setDraft] = useState("");
  const [showSeed, setShowSeed] = useState(false);

  const stats = useMemo(() => aggregateRating(reviews.map((r) => ({ ...r, sentiment: r.sentiment || scoreSentiment(r.body).sentiment }))), [reviews]);
  const pending = useMemo(() => needsResponse(reviews), [reviews]);
  const inconsistent = useMemo(() => reviews.filter((r) => isInconsistent(r)), [reviews]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["reviews"] });

  const isPortfolio = property === "all" || Array.isArray(property);
  const singlePropertyId = !isPortfolio ? property : null;

  const handleReply = async (review) => {
    if (!draft.trim()) return;
    await db.entities.Review.update(review.id, {
      response: draft.trim(),
      responded_at: new Date().toISOString(),
      status: "replied",
    });
    invalidate();
    setDraft("");
    setReplyId(null);
  };

  const handleStatus = async (review, status) => {
    await db.entities.Review.update(review.id, { status });
    invalidate();
  };

  const handleSeed = async () => {
    if (!singlePropertyId) return;
    const now = new Date().toISOString().slice(0, 10);
    const samples = [
      { source: "google", guest: "Maria G.", rating: 5, body: "Spotless room and really friendly staff. The best hotel breakfast." },
      { source: "booking", guest: "James T.", rating: 3, body: "Decent value but a bit noisy near the elevator." },
      { source: "tripadvisor", guest: "Priya S.", rating: 2, body: "Dirty bathroom and rude front desk. Poor experience." },
      { source: "expedia", guest: "Daniel K.", rating: 4, body: "Clean and comfortable, great location. Would recommend." },
      { source: "google", guest: "Ana L.", rating: 1, body: "Terrible service, room was not clean at all. Never again." },
    ];
    const prop = singlePropertyId;
    const withSentiment = samples.map((s) => ({ ...s, sentiment: scoreSentiment(s.body).sentiment, status: "new", review_date: now, property_id: prop }));
    // build review rows
    for (const s of withSentiment) {
      await db.entities.Review.create({ ...s, rating: Number(s.rating), body: s.body });
    }
    invalidate();
  };

  if (isLoading) return <p className="text-slate-500">Loading reviews…</p>;

  const distData = Object.entries(stats.distribution).map(([star, count]) => ({ name: `${star}★`, count })).filter((d) => d.count > 0);
  const sentData = Object.entries(stats.bySentiment).filter(([, c]) => c > 0).map(([k, v]) => ({ name: k, value: v, color: SENTIMENT_COLOR[k] }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#FFB547]">Reputation</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Guest Reviews</h1>
          <p className="mt-1 text-sm text-slate-400">
            {dateRange.from || "—"} → {dateRange.to || "—"} · {num(stats.total)} reviews · {pct(stats.responseRate)} responded
          </p>
        </div>
        <button
          onClick={() => { if (isPortfolio) { alert("Select a single property to seed demo reviews."); return; } handleSeed(); }}
          className="rounded-lg border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-white/5"
        >
          Seed demo reviews
        </button>
      </header>

      {/* Without this, a failed read showed a 0.0 star average, 0 unresolved, and an
          inbox that invited the operator to seed demo reviews — as if no guest had
          ever written in. */}
      {reviewsQ.isError && (
        <ErrorState
          title="Could not load reviews"
          description="The 0.0 star average and empty inbox below are not your reputation — this read failed. Unanswered guest reviews may be live on Google and the OTAs right now while this page reports nothing to answer."
          error={reviewsQ.error}
          onRetry={() => { reviewsQ.refetch(); }}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Average Rating", `${stats.avg.toFixed(1)} ★`, CCOL("#FFB547")],
          ["Reviews", num(stats.total), CCOL("#00D4FF")],
          ["Unresolved", num(pending.length), CCOL("#FF6B6B")],
          ["Needs Human Look", num(inconsistent.length), CCOL("#FFB547")],
        ].map(([label, value, color]) => (
          <div key={label} className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4">
            <p className="text-[11px] uppercase tracking-widest text-slate-400">{label}</p>
            <p className="mt-2 font-heading text-2xl font-semibold" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Rating distribution">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={distData}>
              <XAxis dataKey="name" stroke="#64748b" fontSize={12} />
              <YAxis stroke="#64748b" fontSize={12} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#0F1F35", border: "1px solid #ffffff22", borderRadius: 8 }} />
              <Bar dataKey="count" fill="#00D4FF" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Sentiment mix">
          {sentData.length ? (
            // Shared donut: the label placement engine keeps every slice's
            // callout readable and non-overlapping. The old inline label put
            // text at the slice's own angle with no de-collision, and hid any
            // slice under 2% outright, so a handful of negative reviews could
            // vanish from the chart entirely.
            <PieDonut
              data={sentData}
              type="donut"
              height={340}
              legendColumns={3}
              formatter={(v) => `${num(v)} ${Number(v) === 1 ? "review" : "reviews"}`}
            />
          ) : (
            <p className="text-sm text-slate-400">No reviews to chart yet.</p>
          )}
        </Card>
      </div>

      <Card title="Review inbox" subtitle={`${num(pending.length)} unanswered · ${num(stats.replied)} responded`}>
        {reviews.length === 0 ? (
          <div className="text-center">
            <p className="text-sm text-slate-400">No reviews in this period.</p>
            <p className="mt-1 text-xs text-slate-500">
              Reviews are aggregated from Google, TripAdvisor and OTA channels. Use "Seed demo reviews" on a single property
              to preview the inbox.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reviews.map((r) => {
              const sent = r.sentiment || scoreSentiment(r.body).sentiment;
              const sColor = SENTIMENT_COLOR[sent];
              const inconsistent = isInconsistent(r);
              return (
                <div key={r.id} className="rounded-xl border border-white/5 bg-[#0A1628]/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-300">
                      {SOURCE_LABELS[r.source] || r.source || "Other"}
                    </span>
                    <span className="text-xs text-white">{r.guest_name || "Guest"}</span>
                    <span className="text-xs text-[#FFB547]">{"★".repeat(Math.max(0, Math.min(5, Number(r.rating) || 0)))}{"☆".repeat(Math.max(0, 5 - (Number(r.rating) || 0)))}</span>
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: `${sColor}22`, color: sColor }}>
                      {sent}
                    </span>
                    {inconsistent && (
                      <span className="rounded-full bg-[#FFB547]/15 px-2 py-0.5 text-[10px] font-medium text-[#FFB547]">Mismatch</span>
                    )}
                    <span className="ml-auto text-xs text-slate-500">{r.review_date} · {r.status}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-300">{r.body || r.text}</p>
                  {r.response && (
                    <div className="mt-2 rounded-lg border-l-2 border-[#00E096]/50 bg-[#00E096]/5 px-3 py-2 text-xs text-slate-300">
                      <span className="font-medium text-[#00E096]">Your reply:</span> {r.response}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {replyId === r.id ? (
                      <>
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={2}
                          placeholder="Write a public reply…"
                          className="flex-1 rounded-lg border border-white/10 bg-[#0A1628] px-2 py-1.5 text-xs text-white"
                        />
                        <button onClick={() => handleReply(r)} className="rounded-lg bg-[#00E096] px-3 py-1 text-xs font-medium text-[#04231A]">Send</button>
                        <button onClick={() => { setReplyId(null); setDraft(""); }} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => { setReplyId(r.id); setDraft(r.response || ""); }} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10">
                        {r.response ? "Edit reply" : "Reply"}
                      </button>
                    )}
                    {r.status === "replied" && (
                      <button onClick={() => handleStatus(r, "resolved")} className="rounded-lg border border-[#00E096]/30 px-2 py-1 text-xs text-[#00E096] hover:bg-[#00E096]/10">
                        Mark resolved
                      </button>
                    )}
                    {r.status === "resolved" && (
                      <button onClick={() => handleStatus(r, "new")} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10">
                        Reopen
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function CCOL(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}