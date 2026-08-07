const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await db.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const question = String(body.question || "").trim();
    const propertyId = body.propertyId || "all";
    const dateFrom = body.dateFrom || "";
    const dateTo = body.dateTo || "";

    if (!question) return Response.json({ error: "Question is required" }, { status: 400 });

    // Build filters
    const dateFilter = (dateFrom && dateTo) ? { $gte: dateFrom, $lte: dateTo } : {};
    const propFilter = (propertyId && propertyId !== "all")
      ? (Array.isArray(propertyId) ? { $in: propertyId } : propertyId)
      : null;

    function makeFilter() {
      const f = {};
      if (Object.keys(dateFilter).length > 0) f.date = dateFilter;
      if (propFilter) f.property_id = propFilter;
      return f;
    }

    // Gather relevant data
    const occFilter = makeFilter();
    let occupancy = [];
    let sources = [];
    let payments = [];
    let expenses = [];
    let payroll = [];
    let clerkRecords = [];
    let uploads = [];

    if (Object.keys(occFilter).length > 0) {
      occupancy = await db.asServiceRole.entities.OccupancyDay.filter(occFilter, "date", 500);
      sources = await db.asServiceRole.entities.SourceDay.filter(occFilter, "date", 1000);
      payments = await db.asServiceRole.entities.PaymentDay.filter(occFilter, "date", 500);
    } else {
      occupancy = await db.asServiceRole.entities.OccupancyDay.list("date", 500);
      sources = await db.asServiceRole.entities.SourceDay.list("date", 1000);
      payments = await db.asServiceRole.entities.PaymentDay.list("date", 500);
    }

    const expFilter = {};
    if (propFilter) expFilter.property_id = propFilter;
    expenses = await db.asServiceRole.entities.Expense.filter(expFilter, "-expense_date", 200);
    payroll = await db.asServiceRole.entities.PayrollRun.filter(expFilter, "-payroll_date", 200);
    clerkRecords = await db.asServiceRole.entities.ClerkShiftRecord.filter(expFilter, "-created_date", 500);
    uploads = await db.asServiceRole.entities.UploadedReport.list("-created_date", 50);

    // Build summary stats
    const sum = (arr, key) => arr.reduce((a, r) => a + (Number(r[key]) || 0), 0);
    const totalRevenue = sum(occupancy, "total_revenue");
    const totalRoomsSold = sum(occupancy, "rooms_sold");
    const totalGuests = sum(occupancy, "total_guests");
    const avgAdr = totalRoomsSold > 0 ? totalRevenue / totalRoomsSold : 0;
    const totalPayments = sum(payments, "total");
    const cashTotal = sum(payments, "cash");
    const cardTotal = sum(payments, "amex") + sum(payments, "visa") + sum(payments, "master") + sum(payments, "discover");
    const refunds = Math.abs(sum(payments, "closed_balance_folio")) + Math.abs(sum(payments, "loyalty_discount"));
    const totalExpenses = sum(expenses, "amount");
    const totalPayroll = sum(payroll, "total_pay");

    // Source breakdown
    const sourceMap = {};
    sources.forEach((s) => {
      const name = s.source || s.code || "Unknown";
      if (!sourceMap[name]) sourceMap[name] = { revenue: 0, stays: 0 };
      sourceMap[name].revenue += Number(s.net_revenue) || 0;
      sourceMap[name].stays += Number(s.stays) || 0;
    });
    const topSources = Object.entries(sourceMap)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Clerk breakdown
    const clerkMap = {};
    clerkRecords.forEach((c) => {
      if (c.record_type === "payment" && c.clerk_name) {
        if (!clerkMap[c.clerk_name]) clerkMap[c.clerk_name] = { adjusted: 0, actual: 0, count: 0 };
        clerkMap[c.clerk_name].adjusted += Number(c.adjusted) || 0;
        clerkMap[c.clerk_name].actual += Number(c.actual) || 0;
        clerkMap[c.clerk_name].count += 1;
      }
    });
    const topClerks = Object.entries(clerkMap)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.adjusted - a.adjusted)
      .slice(0, 10);

    // Daily revenue for trend
    const dailyRevenue = occupancy
      .map((r) => ({ date: String(r.date).slice(0, 10), revenue: Number(r.total_revenue) || 0, rooms: Number(r.rooms_sold) || 0 }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    // Property breakdown
    const propMap = {};
    occupancy.forEach((r) => {
      const name = r.property_name || r.property_id || "Unknown";
      if (!propMap[name]) propMap[name] = { revenue: 0, roomsSold: 0, days: 0 };
      propMap[name].revenue += Number(r.total_revenue) || 0;
      propMap[name].roomsSold += Number(r.rooms_sold) || 0;
      propMap[name].days += 1;
    });
    const propBreakdown = Object.entries(propMap)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.revenue - a.revenue);

    // Manual entries count
    const manualEntries = occupancy.filter((r) => r.report_type === "manual_entry").length;

    const summary = {
      period: { from: dateFrom, to: dateTo, propertyId },
      totals: {
        totalRevenue, totalRoomsSold, totalGuests, avgAdr,
        totalPayments, cashTotal, cardTotal, refunds,
        totalExpenses, totalPayroll, netProfit: totalRevenue - totalExpenses - totalPayroll,
        manualEntries,
      },
      topSources,
      topClerks,
      dailyRevenue: dailyRevenue.slice(-14),
      propBreakdown,
      uploads: uploads.map((u) => ({ file_name: u.file_name, report_type: u.report_type, rows_imported: u.rows_imported, date: String(u.created_date).slice(0, 10) })),
      recordCounts: {
        occupancy: occupancy.length, sources: sources.length,
        payments: payments.length, expenses: expenses.length,
        payroll: payroll.length, clerk: clerkRecords.length, uploads: uploads.length,
      },
    };

    // Build prompt for LLM
    const prompt = `You are the Red Roof Intelligence AI Assistant. Answer the user's question using ONLY the data provided below. 
Do not make up numbers. If the data doesn't contain the answer, say so clearly.

When answering:
- Reference specific numbers from the data
- Use Indian number formatting for currency (e.g., $10,00,000)
- For "last month" or relative dates, use the period provided
- Mention which records or properties the data comes from
- For comparisons, show both values and the difference
- Return tables in markdown format when appropriate

QUESTION: ${question}

DATA SUMMARY:
${JSON.stringify(summary, null, 2)}`;

    const llmResponse = await db.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      model: "automatic",
    });

    return Response.json({
      answer: typeof llmResponse === "string" ? llmResponse : JSON.stringify(llmResponse),
      summary,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}