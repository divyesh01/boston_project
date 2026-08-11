import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { db } from '@/api/base44Client';
import { serverAiQueryRateLimiter } from '@/api/base44Client';
import React, { useState, useRef, useEffect } from "react";
import { Bot, X, Send, Sparkles, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { useAuth } from "@/lib/AuthContext";
const SUGGESTIONS = [
    "Show today's executive summary",
    "What was my ADR in March for RRI1416?",
    "Show Middleboro on April 26, 2026",
    "How many rooms were sold and vacant this week?",
    "How much revenue did Expedia generate this month?",
    "Which OTA generated the most revenue?",
    "What were today's payments and refunds?",
    "Which clerk had the largest cash variance?",
    "What were last week's expenses?",
    "Compare March vs April",
];
export default function AIAssistant() {
    const { property, dateRange } = useGlobalFilters();
    const { user } = useAuth();
    const [open, setOpen] = useState(false);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const scrollRef = useRef(null);
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, loading]);
    const handleAsk = async (question) => {
        if (!question.trim() || loading)
            return;
        const q = question.trim();
        // Rate limiting for AI queries
        try {
            const rateLimit = await serverAiQueryRateLimiter.check();
            if (!rateLimit.allowed) {
                setMessages((prev) => [...prev, {
                        role: "assistant",
                        text: `Too many AI queries. Please try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`
                    }]);
                return;
            }
        }
        catch (e) {
            setMessages((prev) => [...prev, { role: "assistant", text: "Rate limiter check failed. Please try again." }]);
            setLoading(false);
            return;
        }
        setMessages((prev) => [...prev, { role: "user", text: q }]);
        setInput("");
        setLoading(true);
        try {
            const propertyId = Array.isArray(property) ? property : (property === "all" ? "all" : property);
            // Scope AI to the properties this user is permitted to access.
            // owner/admin or property_access 'all' => unrestricted (null); otherwise only their property_access ids.
            const isRoot = user && (user.role === "owner" || user.role === "admin");
            const allowedPropertyIds = !user || isRoot || user.property_access === "all"
                ? null
                : Array.isArray(user.property_access)
                    ? user.property_access
                    : [];
            const res = await db.functions.invoke("aiAssistant", {
                question: q,
                propertyId,
                dateFrom: dateRange.from || "",
                dateTo: dateRange.to || "",
                allowedPropertyIds,
            });
            setMessages((prev) => [...prev, { role: "assistant", text: res.data.answer || "I couldn't process that question.", summary: res.data.summary }]);
        }
        catch (e) {
            setMessages((prev) => [...prev, { role: "assistant", text: `Sorry, I encountered an error: ${e.response?.data?.error || e.message}. Please try again.` }]);
        }
        setLoading(false);
    };
    return (_jsxs(_Fragment, { children: [!open && (_jsxs("button", { onClick: () => setOpen(true), className: "fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-[#6C63FF] to-[#00D4FF] shadow-lg shadow-[#6C63FF]/30 transition-all hover:scale-105 active:scale-95", style: { bottom: "calc(6rem + env(safe-area-inset-bottom))" }, children: [_jsx(Bot, { className: "h-6 w-6 text-white" }), _jsx("span", { className: "absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#00E096]", children: _jsx(Sparkles, { className: "h-2.5 w-2.5 text-[#040D1A]" }) })] })), _jsx(AnimatePresence, { children: open && (_jsxs(motion.div, { initial: { opacity: 0, y: 20, scale: 0.95 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: 20, scale: 0.95 }, transition: { duration: 0.2 }, className: "fixed bottom-6 right-6 z-50 flex h-[600px] max-h-[80vh] w-[400px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F1F35] shadow-2xl", style: { bottom: "calc(6rem + env(safe-area-inset-bottom))" }, children: [_jsxs("div", { className: "flex items-center justify-between border-b border-white/10 bg-[#0A1628] px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#6C63FF] to-[#00D4FF]", children: _jsx(Bot, { className: "h-4 w-4 text-white" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-white", children: "AI Assistant" }), _jsx("p", { className: "text-[10px] text-slate-500", children: "Local database \u00B7 No internet needed" })] })] }), _jsx("button", { onClick: () => setOpen(false), className: "text-slate-400 hover:text-white", children: _jsx(X, { className: "h-5 w-5" }) })] }), _jsxs("div", { ref: scrollRef, className: "flex-1 space-y-3 overflow-auto p-4", children: [messages.length === 0 && (_jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "rounded-xl bg-[#0A1628]/60 p-3", children: _jsx("p", { className: "text-sm text-slate-300", children: "\uD83D\uDC4B Ask me anything about your hotel data. I can answer questions about revenue, occupancy, payments, expenses, and more." }) }), _jsx("p", { className: "text-xs text-slate-500", children: "Try asking:" }), SUGGESTIONS.map((s) => (_jsx("button", { onClick: () => handleAsk(s), className: "block w-full rounded-lg border border-white/5 bg-[#0A1628]/40 px-3 py-2 text-left text-xs text-slate-300 transition-colors hover:border-[#6C63FF]/30 hover:bg-white/5", children: s }, s)))] })), messages.map((msg, i) => (_jsx("div", { className: `flex ${msg.role === "user" ? "justify-end" : "justify-start"}`, children: _jsx("div", { className: `max-w-[85%] rounded-xl px-3 py-2 text-sm ${msg.role === "user"
                                            ? "bg-[#6C63FF] text-white"
                                            : "bg-[#0A1628] text-slate-200"}`, children: msg.role === "assistant" ? (_jsxs("div", { className: "space-y-2", children: [_jsx("div", { className: "whitespace-pre-wrap break-words", children: _jsx(ReactMarkdown, { components: {
                                                            ul: ({ node: _node, ...p }) => _jsx("ul", { className: "list-disc space-y-1 pl-4", ...p }),
                                                            ol: ({ node: _node, ...p }) => _jsx("ol", { className: "list-decimal space-y-1 pl-4", ...p }),
                                                            li: ({ node: _node, ...p }) => _jsx("li", { className: "text-slate-300", ...p }),
                                                            p: ({ node: _node, ...p }) => _jsx("p", { className: "my-1", ...p }),
                                                        }, children: msg.text }) }), msg.summary && msg.summary.intent === "answer" && (_jsxs("div", { className: "flex flex-wrap gap-1 border-t border-white/5 pt-2 text-[10px] text-slate-500", children: [_jsx("span", { className: "rounded-full bg-[#6C63FF]/10 px-2 py-0.5 text-[#9B8CFF]", children: msg.summary.property }), _jsx("span", { className: "rounded-full bg-white/5 px-2 py-0.5", children: msg.summary.range }), msg.summary.single && _jsx("span", { className: "rounded-full bg-[#00D4FF]/10 px-2 py-0.5 text-[#00D4FF]", children: "Daily" })] })), msg.summary && msg.summary.intent === "missing" && (_jsxs("div", { className: "rounded-lg border border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.06] px-2 py-1.5 text-[10px] text-[#FF6B6B]", children: ["Missing report: ", msg.summary.missing] }))] })) : (_jsx("p", { className: "whitespace-pre-wrap break-words", children: msg.text })) }) }, i))), loading && (_jsx("div", { className: "flex justify-start", children: _jsxs("div", { className: "flex items-center gap-2 rounded-xl bg-[#0A1628] px-3 py-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin text-[#00D4FF]" }), _jsx("span", { className: "text-sm text-slate-400", children: "Searching database\u2026" })] }) }))] }), _jsx("div", { className: "border-t border-white/10 bg-[#0A1628] p-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "text", value: input, onChange: (e) => setInput(e.target.value), onKeyDown: (e) => { if (e.key === "Enter")
                                            handleAsk(input); }, placeholder: "Ask about revenue, occupancy, payments\u2026", className: "flex-1 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]", disabled: loading }), _jsx("button", { onClick: () => handleAsk(input), disabled: loading || !input.trim(), className: "flex h-9 w-9 items-center justify-center rounded-lg bg-[#6C63FF] text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50", children: _jsx(Send, { className: "h-4 w-4" }) })] }) })] })) })] }));
}
