import { db } from '@/api/base44Client';
import { serverAiQueryRateLimiter } from '@/api/base44Client';

import React, { useState, useRef, useEffect } from "react";
import { Bot, X, Send, Sparkles, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";

import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { getDailyAggregates, buildSyntheticRows } from "@/lib/dailyAggregates";

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
    if (!question.trim() || loading) return;
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
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", text: "Rate limiter check failed. Please try again." }]);
      setLoading(false);
      return;
    }

    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setInput("");
    setLoading(true);
    try {
      const propertyId = Array.isArray(property) ? property : (property === "all" ? "all" : property);
      // No `allowedPropertyIds` computed here any more. This component used to
      // derive the AI's property scope from the `user` object and send it with
      // the request — the thing being authorized deciding its own authorization,
      // and it resolved to "unrestricted" whenever `user` was null. The scope is
      // now resolved from the session inside base44Client.functions.invoke, and
      // getDailyAggregates clamps itself through db.entities.

      // Pre-aggregate stats locally to avoid lag in the AI Assistant backend
      let synthetic = {};
      try {
        const aggs = await getDailyAggregates({
          propertyId,
          from: dateRange.from || "",
          to: dateRange.to || ""
        });
        if (aggs && aggs.length > 0) {
          synthetic = buildSyntheticRows(aggs);
        }
      } catch (err) {
        console.warn("Failed to gather synthetic aggregates:", err);
      }

      const res = await db.functions.invoke("aiAssistant", {
        question: q,
        propertyId,
        dateFrom: dateRange.from || "",
        dateTo: dateRange.to || "",
        synthetic,
      });
      setMessages((prev) => [...prev, { role: "assistant", text: res.data.answer || "I couldn't process that question.", summary: res.data.summary }]);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", text: `Sorry, I encountered an error: ${e.response?.data?.error || e.message}. Please try again.` }]);
    }
    setLoading(false);
  };

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open AI Assistant"
          className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-[#6C63FF] to-[#00D4FF] shadow-lg shadow-[#6C63FF]/30 transition-all hover:scale-105 active:scale-95"
          style={{ bottom: "calc(6rem + env(safe-area-inset-bottom))" }}
        >
          <Bot className="h-6 w-6 text-white" />
          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#00E096]">
            <Sparkles className="h-2.5 w-2.5 text-[#040D1A]" />
          </span>
        </button>
      )}

      {/* Chat panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-6 right-6 z-50 flex h-[600px] max-h-[80vh] w-[400px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F1F35] shadow-2xl"
            style={{ bottom: "calc(6rem + env(safe-area-inset-bottom))" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#0A1628] px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#6C63FF] to-[#00D4FF]">
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">AI Assistant</p>
                  <p className="text-[10px] text-slate-500">Local database · No internet needed</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-4">
              {messages.length === 0 && (
                <div className="space-y-3">
                  <div className="rounded-xl bg-[#0A1628]/60 p-3">
                    <p className="text-sm text-slate-300">👋 Ask me anything about your hotel data. I can answer questions about revenue, occupancy, payments, expenses, and more.</p>
                  </div>
                  <p className="text-xs text-slate-500">Try asking:</p>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleAsk(s)}
                      className="block w-full rounded-lg border border-white/5 bg-[#0A1628]/40 px-3 py-2 text-left text-xs text-slate-300 transition-colors hover:border-[#6C63FF]/30 hover:bg-white/5"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-[#6C63FF] text-white"
                        : "bg-[#0A1628] text-slate-200"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <div className="space-y-2">
                        <div className="whitespace-pre-wrap break-words">
                          <ReactMarkdown
                            components={{
                              ul: ({ node: _node, ...p }) => <ul className="list-disc space-y-1 pl-4" {...p} />,
                              ol: ({ node: _node, ...p }) => <ol className="list-decimal space-y-1 pl-4" {...p} />,
                              li: ({ node: _node, ...p }) => <li className="text-slate-300" {...p} />,
                              p: ({ node: _node, ...p }) => <p className="my-1" {...p} />,
                            }}
                          >
                            {msg.text}
                          </ReactMarkdown>
                        </div>
                        {msg.summary && msg.summary.intent === "answer" && (
                          <div className="flex flex-wrap gap-1 border-t border-white/5 pt-2 text-[10px] text-slate-500">
                            <span className="rounded-full bg-[#6C63FF]/10 px-2 py-0.5 text-[#9B8CFF]">{msg.summary.property}</span>
                            <span className="rounded-full bg-white/5 px-2 py-0.5">{msg.summary.range}</span>
                            {msg.summary.single && <span className="rounded-full bg-[#00D4FF]/10 px-2 py-0.5 text-[#00D4FF]">Daily</span>}
                          </div>
                        )}
                        {msg.summary && msg.summary.intent === "missing" && (
                          <div className="rounded-lg border border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.06] px-2 py-1.5 text-[10px] text-[#FF6B6B]">
                            Missing report: {msg.summary.missing}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                    )}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-xl bg-[#0A1628] px-3 py-2">
                    <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
                    <span className="text-sm text-slate-400">Searching database…</span>
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-white/10 bg-[#0A1628] p-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAsk(input); }}
                  placeholder="Ask about revenue, occupancy, payments…"
                  className="flex-1 rounded-lg border border-white/10 bg-[#040D1A] px-3 py-2 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => handleAsk(input)}
                  disabled={loading || !input.trim()}
                  aria-label="Send message"
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#6C63FF] text-white transition-colors hover:bg-[#5b52e8] disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}