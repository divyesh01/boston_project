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
  SOURCE_LABELS, reviewSentiment, isInconsistent, aggregateRating, needsResponse, hasPublishedResponse,
} from "@/lib/reputationService";
import { ErrorState } from "@/components/ui/status";

const SENTIMENT_COLOR = { positive: "#00E096", neutral: "#FFB547", negative: "#FF6B6B" };

export default function Reviews() {
  const { dateRange, property } = useGlobalFilters();
  const queryClient = useQueryClient();
  useRealtimeInvalidation(["reviews"]);

  const reviewsQ = useReviews(dateRange, property);
  const { data: reviews = [], isLoading } = reviewsQ;

  const [replyId, setReplyId] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const stats = useMemo(() => aggregateRating(reviews), [reviews]);
  const pending = useMemo(() => needsResponse(reviews), [reviews]);
  const inconsistent = useMemo(() => reviews.filter((r) => isInconsistent(r)), [reviews]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["reviews"] });

  const handleReply = async (review) => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    const text = draft.trim();
    try {
      await db.entities.Review.update(review.id, { response_draft: text });
      const saved = await db.entities.Review.filter({ id: review.id });
      if (!saved.some((row) => row.response_draft === text)) throw new Error("This backend did not retain the response draft. Copy your text before leaving this page.");
      await invalidate();
      setDraft(""); setReplyId(null);
      setNotice({ type: "ok", text: "Response draft saved in this app. Publish it directly on the review provider's website." });
    } catch (err) {
      setNotice({ type: "error", text: `Draft could not be saved: ${err?.message || err}. Your text is kept below.` });
    } finally { setBusy(false); }
  };

  const handleStatus = async (review, status) => {
    if (busy) return;
    setBusy(true);
    try {
      await db.entities.Review.update(review.id, { status });
      await invalidate();
      setNotice({ type: "ok", text: status === "resolved" ? "Marked handled in this app." : "Review reopened in this app." });
    } catch (err) { setNotice({ type: "error", text: `Status was not saved: ${err?.message || err}` }); }
    finally { setBusy(false); }
  };

  if (isLoading) return <p className="text-slate-500">Loading reviews…</p>;
  if (reviewsQ.isError) return <ErrorState title="Could not load reviews" description="Review totals and actions are unavailable until the saved reviews load." error={reviewsQ.error} onRetry={reviewsQ.refetch} />;

  const distData = Object.entries(stats.distribution).map(([star, count]) => ({ name: `${star}★`, count })).filter((d) => d.count > 0);
  const sentData = Object.entries(stats.bySentiment).filter(([, c]) => c > 0).map(([k, v]) => ({ name: k, value: v, color: SENTIMENT_COLOR[k] }));

  return (
    <fieldset disabled={busy} className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#FFB547]">Reputation</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Guest Reviews</h1>
          <p className="mt-1 text-sm text-slate-400">
            {dateRange.from || "—"} → {dateRange.to || "—"} · {num(stats.total)} saved reviews · {pct(stats.responseRate)} confirmed published responses
          </p>
        </div>
      </header>
      <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">Automatic review fetching and public replies are unavailable. This inbox shows records saved in this app. Save a response draft here, then publish it on the provider's website.</p>
      {notice && <p role={notice.type === "error" ? "alert" : "status"} className={notice.type === "error" ? "text-sm text-red-400" : "text-sm text-emerald-400"}>{notice.text}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Average Rating", stats.rated ? `${stats.avg.toFixed(1)} ★` : "No ratings", CCOL("#FFB547")],
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

      <Card title="Review inbox" subtitle={`${num(pending.length)} need attention · ${num(stats.replied)} confirmed published responses`}>
        {reviews.length === 0 ? (
          <div className="text-center">
            <p className="text-sm text-slate-400">No reviews in this period.</p>
            <p className="mt-1 text-xs text-slate-500">
              No saved reviews match these filters. Check the review provider's website for current guest feedback.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reviews.map((r) => {
              const sent = reviewSentiment(r);
              const sColor = SENTIMENT_COLOR[sent];
              const inconsistent = isInconsistent(r);
              const rating = Number(r.rating);
              const stars = Number.isFinite(rating) && rating >= 1 && rating <= 5 ? Math.round(rating) : null;
              return (
                <div key={r.id} className="rounded-xl border border-white/5 bg-[#0A1628]/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-300">
                      {SOURCE_LABELS[r.source] || r.source || "Other"}
                    </span>
                    <span className="text-xs text-white">{r.guest_name || "Guest"}</span>
                    <span className="text-xs text-[#FFB547]">{stars == null ? "Unrated" : `${"\u2605".repeat(stars)}${"\u2606".repeat(5 - stars)}`}</span>
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
                      <span className="font-medium text-[#00E096]">{hasPublishedResponse(r) ? "Published response:" : "Saved response (publication unconfirmed):"}</span> {r.response}
                    </div>
                  )}
                  {r.response_draft && <p className="mt-2 rounded-lg bg-white/5 p-3 text-xs text-slate-300"><strong>Response draft:</strong> {r.response_draft}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {replyId === r.id ? (
                      <>
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={2}
                          placeholder="Draft a response to publish on the provider's website…"
                          aria-label="Response draft"
                          className="flex-1 rounded-lg border border-white/10 bg-[#0A1628] px-2 py-1.5 text-xs text-white"
                        />
                        <button disabled={busy || !draft.trim()} onClick={() => handleReply(r)} className="rounded-lg bg-[#00E096] px-3 py-1 text-xs font-medium text-[#04231A] disabled:opacity-50">{busy ? "Saving…" : "Save draft"}</button>
                        <button onClick={() => { if (draft.trim() && !window.confirm("Discard this unsaved response draft?")) return; setReplyId(null); setDraft(""); }} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => { if (replyId && draft.trim() && !window.confirm("Discard the unsaved response draft and open this review?")) return; setReplyId(r.id); setDraft(r.response_draft || r.response || ""); }} className="rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10">
                        {r.response_draft ? "Edit draft" : "Draft response"}
                      </button>
                    )}
                    {r.status !== "resolved" && (
                      <button onClick={() => handleStatus(r, "resolved")} className="rounded-lg border border-[#00E096]/30 px-2 py-1 text-xs text-[#00E096] hover:bg-[#00E096]/10">
                        Mark handled locally
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
    </fieldset>
  );
}

function CCOL(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
