import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, PieChart, Pie, Cell, } from "recharts";
import Card from "@/components/ui-exec/Card";
import { useReviews } from "@/lib/useHotelData";
import { num, pct } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { SOURCE_LABELS, scoreSentiment, isInconsistent, aggregateRating, needsResponse, } from "@/lib/reputationService";
const SENTIMENT_COLOR = { positive: "#00E096", neutral: "#FFB547", negative: "#FF6B6B" };
const CHART_COLORS = ["#6C63FF", "#00D4FF", "#00E096", "#FFB547", "#FF6B6B"];
export default function Reviews() {
    const { dateRange, property } = useGlobalFilters();
    const queryClient = useQueryClient();
    useRealtimeInvalidation(["reviews"]);
    const { data: reviews = [], isLoading } = useReviews(dateRange, property);
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
        if (!draft.trim())
            return;
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
        if (!singlePropertyId)
            return;
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
    if (isLoading)
        return _jsx("p", { className: "text-slate-500", children: "Loading reviews\u2026" });
    const distData = Object.entries(stats.distribution).map(([star, count]) => ({ name: `${star}★`, count })).filter((d) => d.count > 0);
    const sentData = Object.entries(stats.bySentiment).filter(([, c]) => c > 0).map(([k, v]) => ({ name: k, value: v, color: SENTIMENT_COLOR[k] }));
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { className: "flex flex-wrap items-end justify-between gap-4", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#FFB547]", children: "Reputation" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Guest Reviews" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: [dateRange.from || "—", " \u2192 ", dateRange.to || "—", " \u00B7 ", num(stats.total), " reviews \u00B7 ", pct(stats.responseRate), " responded"] })] }), _jsx("button", { onClick: () => { if (isPortfolio) {
                            alert("Select a single property to seed demo reviews.");
                            return;
                        } handleSeed(); }, className: "rounded-lg border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-white/5", children: "Seed demo reviews" })] }), _jsx("div", { className: "grid gap-4 sm:grid-cols-2 lg:grid-cols-4", children: [
                    ["Average Rating", `${stats.avg.toFixed(1)} ★`, CCOL("#FFB547")],
                    ["Reviews", num(stats.total), CCOL("#00D4FF")],
                    ["Unresolved", num(pending.length), CCOL("#FF6B6B")],
                    ["Needs Human Look", num(inconsistent.length), CCOL("#FFB547")],
                ].map(([label, value, color]) => (_jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4", children: [_jsx("p", { className: "text-[11px] uppercase tracking-widest text-slate-400", children: label }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold", style: { color }, children: value })] }, label))) }), _jsxs("div", { className: "grid gap-6 lg:grid-cols-2", children: [_jsx(Card, { title: "Rating distribution", children: _jsx(ResponsiveContainer, { width: "100%", height: 220, children: _jsxs(BarChart, { data: distData, children: [_jsx(XAxis, { dataKey: "name", stroke: "#64748b", fontSize: 12 }), _jsx(YAxis, { stroke: "#64748b", fontSize: 12, allowDecimals: false }), _jsx(Tooltip, { contentStyle: { background: "#0F1F35", border: "1px solid #ffffff22", borderRadius: 8 } }), _jsx(Bar, { dataKey: "count", fill: "#00D4FF", radius: [4, 4, 0, 0] })] }) }) }), _jsxs(Card, { title: "Sentiment mix", children: [sentData.length ? (_jsx(ResponsiveContainer, { width: "100%", height: 220, children: _jsxs(PieChart, { children: [_jsx(Pie, { data: sentData, dataKey: "value", nameKey: "name", innerRadius: 50, outerRadius: 80, paddingAngle: 3, label: ({ name, value, percent }) => { const share = (percent || 0) * 100; const t = name && name.length > 12 ? name.slice(0, 10) + "\u2026" : name; if (share < 2) return ""; return `${t} (${value})`; }, labelLine: { stroke: "#475569", strokeWidth: 1 }, children: sentData.map((entry) => _jsx(Cell, { fill: entry.color }, entry.name)) }), _jsx(Tooltip, { contentStyle: { background: "#0F1F35", border: "1px solid #ffffff22", borderRadius: 8 } })] }) })) : (_jsx("p", { className: "text-sm text-slate-400", children: "No reviews to chart yet." })), sentData.length > 0 && (_jsx("div", { className: "mt-2 flex flex-wrap justify-center gap-4", children: sentData.map((s) => (_jsxs("span", { className: "flex items-center gap-1.5 text-xs text-slate-400", children: [_jsx("span", { className: "h-2.5 w-2.5 rounded-sm", style: { background: s.color } }), s.name, " \u00B7 ", s.value] }, s.name))) }))] })] }), _jsx(Card, { title: "Review inbox", subtitle: `${num(pending.length)} unanswered · ${num(stats.replied)} responded`, children: reviews.length === 0 ? (_jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-sm text-slate-400", children: "No reviews in this period." }), _jsx("p", { className: "mt-1 text-xs text-slate-500", children: "Reviews are aggregated from Google, TripAdvisor and OTA channels. Use \"Seed demo reviews\" on a single property to preview the inbox." })] })) : (_jsx("div", { className: "space-y-3", children: reviews.map((r) => {
                        const sent = r.sentiment || scoreSentiment(r.body).sentiment;
                        const sColor = SENTIMENT_COLOR[sent];
                        const inconsistent = isInconsistent(r);
                        return (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/50 p-3", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("span", { className: "rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-300", children: SOURCE_LABELS[r.source] || r.source || "Other" }), _jsx("span", { className: "text-xs text-white", children: r.guest_name || "Guest" }), _jsxs("span", { className: "text-xs text-[#FFB547]", children: ["★".repeat(Math.max(0, Math.min(5, Number(r.rating) || 0))), "☆".repeat(Math.max(0, 5 - (Number(r.rating) || 0)))] }), _jsx("span", { className: "rounded-full px-2 py-0.5 text-[10px] font-medium", style: { background: `${sColor}22`, color: sColor }, children: sent }), inconsistent && (_jsx("span", { className: "rounded-full bg-[#FFB547]/15 px-2 py-0.5 text-[10px] font-medium text-[#FFB547]", children: "Mismatch" })), _jsxs("span", { className: "ml-auto text-xs text-slate-500", children: [r.review_date, " \u00B7 ", r.status] })] }), _jsx("p", { className: "mt-2 text-sm text-slate-300", children: r.body || r.text }), r.response && (_jsxs("div", { className: "mt-2 rounded-lg border-l-2 border-[#00E096]/50 bg-[#00E096]/5 px-3 py-2 text-xs text-slate-300", children: [_jsx("span", { className: "font-medium text-[#00E096]", children: "Your reply:" }), " ", r.response] })), _jsxs("div", { className: "mt-2 flex flex-wrap items-center gap-2", children: [replyId === r.id ? (_jsxs(_Fragment, { children: [_jsx("textarea", { value: draft, onChange: (e) => setDraft(e.target.value), rows: 2, placeholder: "Write a public reply\u2026", className: "flex-1 rounded-lg border border-white/10 bg-[#0A1628] px-2 py-1.5 text-xs text-white" }), _jsx("button", { onClick: () => handleReply(r), className: "rounded-lg bg-[#00E096] px-3 py-1 text-xs font-medium text-[#04231A]", children: "Send" }), _jsx("button", { onClick: () => { setReplyId(null); setDraft(""); }, className: "rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300", children: "Cancel" })] })) : (_jsx("button", { onClick: () => { setReplyId(r.id); setDraft(r.response || ""); }, className: "rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10", children: r.response ? "Edit reply" : "Reply" })), r.status === "replied" && (_jsx("button", { onClick: () => handleStatus(r, "resolved"), className: "rounded-lg border border-[#00E096]/30 px-2 py-1 text-xs text-[#00E096] hover:bg-[#00E096]/10", children: "Mark resolved" })), r.status === "resolved" && (_jsx("button", { onClick: () => handleStatus(r, "new"), className: "rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10", children: "Reopen" }))] })] }, r.id));
                    }) })) })] }));
}
function CCOL(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
