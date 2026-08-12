import {
  toCents, fromCents, toRate, fromRate, add, subtract, multiply, divide, divideRate,
  sumCents, avgCents, weightedAvg, formatCents, formatRate,
  portfolioOccupancy, portfolioAdr, portfolioRevpar
} from '@/lib/decimal';
import { commissionFor } from '@/lib/hotel';
import { getTaxConfig, TAX_SOURCES } from '@/lib/taxConfig';
import { getEffectiveTaxRates, getTaxSettings } from '@/lib/taxSettings';
import { getCcFeeRate, getCcFeeOnRefunds } from '@/lib/commissionRates';
import { CARD_METHODS, refundTotal, refundTotalFromTotals } from '@/lib/paymentNorm';

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= from && d <= to;
}

function sum(rows, key) {
  return fromCents(sumCents((rows || []).map(r => r[key])));
}

function avg(rows, key) {
  return (rows || []).length ? sum(rows, key) / rows.length : 0;
}

// Classify booking source into tax bucket
function classifySource(r) {
  const text = `${r.source || ""} ${r.code || ""}`.toUpperCase();
  if (/EXPEDIA.*HOTEL COLLECT|EHC/.test(text)) return "EXPEDIA_HC";
  if (/BOOKING\.?COM.*HOTEL COLLECT|BHC/.test(text)) return "BOOKING_HC";
  if (/WALK|WIN/.test(text)) return "WALK_IN";
  if (/PROPERTY BOOKING|PRP|RR WEBSITE|WEB|RED ROOF APP|APP|CONTACT CENTER|CRS/.test(text)) return "PROPERTY_BOOKING";
  return "OTHER_OTA";
}

export class CalculationService {
  static calculateOccupancyMetrics(occRows = [], propertyRoomCounts = {}) {
    const revenue = sumCents(occRows.map(r => r.total_revenue));
    const roomsSold = sumCents(occRows.map(r => r.rooms_sold));

    // Sum per-row total_rooms (actual inventory per date), fallback to Property.rooms
    let capacity = 0;
    occRows.forEach((r) => {
      const pid = r.property_id || '_default';
      const rowRooms = Number(r.total_rooms) || 0;
      if (rowRooms > 0) {
        capacity += rowRooms * 100;
      } else {
        const rooms = propertyRoomCounts?.[pid] || 100;
        capacity += rooms * 100;
      }
    });

    const occupancy = capacity ? divideRate(roomsSold, capacity) : 0;
    const adr = roomsSold ? divide(revenue, roomsSold) : 0;
    const revpar = capacity ? divide(revenue, capacity) : 0;

    return {
      revenue: fromCents(revenue),
      roomsSold: fromCents(roomsSold),
      capacity: fromCents(capacity),
      occupancy: fromRate(occupancy),
      adr: fromCents(adr),
      revpar: fromCents(revpar),
    };
  }

  static calculatePerPropertyStats(occRows = [], properties = []) {
    const byProp = new Map();
    occRows.forEach((r) => {
      const pid = r.property_id || '_default';
      if (!byProp.has(pid)) byProp.set(pid, []);
      byProp.get(pid).push(r);
    });

    const results = [];
    byProp.forEach((rows, pid) => {
      const prop = properties.find((p) => p.id === pid);
      const fallbackRooms = prop?.rooms || 100;
      const revenue = sumCents(rows.map(r => r.total_revenue));
      const roomsSold = sumCents(rows.map(r => r.rooms_sold));
      // Sum per-row total_rooms, fallback to Property.rooms
      let capacity = 0;
      rows.forEach((r) => {
        const rowRooms = Number(r.total_rooms) || 0;
        capacity += rowRooms > 0 ? rowRooms : fallbackRooms;
      });
      capacity *= 100;
      results.push({
        property_id: pid,
        property_name: prop?.name || rows[0]?.property_name || 'Unknown',
        revenue: fromCents(revenue),
        roomsSold: fromCents(roomsSold),
        occupancy: capacity ? fromRate(divideRate(roomsSold, capacity)) : 0,
        adr: roomsSold ? fromCents(divide(revenue, roomsSold)) : 0,
        revpar: capacity ? fromCents(divide(revenue, capacity)) : 0,
        days: rows.length,
        rooms: fallbackRooms,
      });
    });
    return results.sort((a, b) => b.revenue - a.revenue);
  }

  static calculateChannelMetrics(srcRows = []) {
    const map = new Map();
    srcRows.forEach((r) => {
      const key = r.source || r.code || 'UNKNOWN';
      const cur = map.get(key) || { source: key, gross: 0, stays: 0 };
      cur.gross += Number(r.net_revenue) || 0;
      cur.stays += Number(r.stays) || 0;
      map.set(key, cur);
    });

    return [...map.values()]
      .filter((c) => c.gross > 0 || c.stays > 0)
      .map((c) => {
        const info = commissionFor(c.source);
        let commission = 0;
        if (info.type === 'percentage') commission = c.gross * info.rate;
        else if (info.type === 'fixed') commission = info.rate * c.stays;
        else if (info.type === 'actual') commission = info.rate;
        return {
          ...c,
          ...info,
          commission,
          net: c.gross - commission,
          margin: c.gross ? (c.gross - commission) / c.gross : 0,
        };
      })
      .sort((a, b) => b.net - a.net);
  }

  static calculatePaymentMetrics(payRows = []) {
    const methodTotals = {};
    const allFields = [...CARD_METHODS, 'cash', 'check', 'direct_bill', 'corpay', 'wire_transfer', 'loyalty_certificate', 'loyalty_discount', 'vip_pass', 'other', 'closed_balance_folio'];

    allFields.forEach(key => { methodTotals[key] = sum(payRows, key); });

    const cardTotal = CARD_METHODS.reduce((a, k) => a + (methodTotals[k] || 0), 0);
    const cashTotal = methodTotals.cash || 0;
    const totalCollected = sum(payRows, 'total');
    const refunds = refundTotalFromTotals(methodTotals);
    const netPaymentCollected = totalCollected - refunds;

    return { methodTotals, cardTotal, cashTotal, totalCollected, refunds, netPaymentCollected };
  }

  static calculateTaxLiability(srcRows = [], grossRows = [], propertyId = null, dateRange = { from: '', to: '' }) {
    const taxConfig = getTaxConfig();
    if (!taxConfig.taxEnabled && getTaxSettings().length === 0) return { state: 0, city: 0, other: 0, total: 0 };

    const taxBase = new Map();
    srcRows.forEach((r) => {
      const src = TAX_SOURCES.find((s) => s.key === classifySource(r));
      // Also respect per-source taxExempt from commission rate settings
      const info = commissionFor(r.source || r.code);
      if (!src || !src.taxable || info.taxExempt) return;
      const d = String(r.date).slice(0, 10);
      taxBase.set(d, (taxBase.get(d) || 0) + (Number(r.net_revenue) || 0));
    });

    const taxImp = new Map();
    grossRows.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      const cur = taxImp.get(d) || { state: 0, city: 0, other: 0 };
      cur.state += Number(r.state_tax) || 0;
      cur.city += Number(r.city_tax) || 0;
      cur.other += Number(r.other_tax) || 0;
      taxImp.set(d, cur);
    });

    let state = 0, city = 0, other = 0;
    const dates = new Set([...taxBase.keys(), ...taxImp.keys()]);
    dates.forEach(d => {
      if (!inRange(d, dateRange.from, dateRange.to)) return;
      const imp = taxImp.get(d);
      const hasImported = imp && (imp.state + imp.city + imp.other) > 0.004;
      if (hasImported) {
        state += imp.state;
        city += imp.city;
        other += imp.other;
      } else {
        const base = taxBase.get(d) || 0;
        const r = getEffectiveTaxRates(propertyId, d);
        state += base * r.state;
        city += base * r.city;
        other += base * r.other;
      }
    });

    return { state, city, other, total: state + city + other };
  }

  static calculateMoneyKept(occRows = [], srcRows = [], grossRows = [], payRows = [], expenses = [], payroll = [], dateRange = { from: '', to: '' }, propertyId = null) {
    const gross = sum(occRows, 'total_revenue');
    const ccFee = getCcFeeRate();
    const ccFeeRefunds = getCcFeeOnRefunds();

    const otaCommissions = this.calculateChannelMetrics(srcRows).reduce((a, c) => a + c.commission, 0);

    const cardTotal = sum(payRows, 'total') - sum(payRows, 'cash') - sum(payRows, 'check');
    const ccFees = cardTotal * ccFee;

    const refunds = refundTotal(payRows);
    let refundFees = 0;
    if (ccFeeRefunds) refundFees = refunds * ccFee;

    const expInPeriod = expenses.filter(e => inRange(e.expense_date, dateRange.from, dateRange.to));
    const payInPeriod = payroll.filter(p => inRange(p.pay_period_start, dateRange.from, dateRange.to));
    const totalPayroll = sum(payInPeriod, 'total_pay');
    const operatingExpenses = expInPeriod.filter(e => e.category !== 'payroll').reduce((a, e) => a + (e.amount || 0), 0);

    const taxLiability = this.calculateTaxLiability(srcRows, grossRows, propertyId, dateRange);
    const estimatedTaxes = taxLiability.total;

    const totalDeductions = otaCommissions + ccFees + refundFees + refunds + totalPayroll + operatingExpenses + estimatedTaxes;
    const kept = gross - totalDeductions;

    return {
      gross,
      otaCommissions,
      ccFees,
      refundFees,
      refunds,
      totalPayroll,
      operatingExpenses,
      estimatedTaxes,
      totalDeductions,
      kept,
      keepRate: gross > 0 ? kept / gross : 0,
    };
  }

  static calculateProfitMetrics(occRows, payRows, expenses, payroll, dateRange) {
    const grossRevenue = sum(occRows, 'total_revenue');
    const refundsAndAdjustments = refundTotal(payRows);
    const netRevenue = grossRevenue - refundsAndAdjustments;

    const expensesInPeriod = expenses.filter(e => inRange(e.expense_date, dateRange.from, dateRange.to));
    const payrollInPeriod = payroll.filter(p => inRange(p.pay_period_start, dateRange.from, dateRange.to));
    const totalPayroll = sum(payrollInPeriod, 'total_pay');
    const operatingExpenses = expensesInPeriod.filter(e => e.category !== 'payroll').reduce((a, e) => a + (e.amount || 0), 0);
    const totalCosts = totalPayroll + operatingExpenses;

    const operatingProfit = netRevenue - totalCosts;
    const profitMargin = netRevenue > 0 ? operatingProfit / netRevenue : 0;

    return { grossRevenue, netRevenue, totalPayroll, operatingExpenses, totalCosts, operatingProfit, profitMargin };
  }

  static calculateForecast(historicalData, assumptions) {
    const { dailyRevenue, dailyOccupancy, dailyAdr, dailyRevpar, days } = historicalData;
    const { rateAdjust, occupancyAdjust, adrAdjust, availableRooms, otaCommission, expenseAdjust, horizonDays } = assumptions;

    const adjRate = 1 + (rateAdjust || 0) / 100;
    const adjOcc = Math.min(1, Math.max(0, dailyOccupancy + (occupancyAdjust || 0) / 100));
    const adjAdr = (dailyAdr || 50) * adjRate + (adrAdjust || 0);

    const projectedRoomsSold = Math.round(availableRooms * adjOcc * horizonDays);
    const projectedRevenue = projectedRoomsSold * adjAdr;
    const otaCommissionAmount = projectedRevenue * (otaCommission || 0) / 100;
    const baseExpenses = dailyRevenue * horizonDays * 0.65;
    const projectedExpenses = baseExpenses * (1 + (expenseAdjust || 0) / 100);
    const netProfit = projectedRevenue - projectedExpenses - otaCommissionAmount;
    const projectedRevpar = availableRooms > 0 ? projectedRevenue / (availableRooms * horizonDays) : 0;

    return {
      revenue: projectedRevenue,
      roomsSold: projectedRoomsSold,
      occupancy: adjOcc,
      adr: adjAdr,
      revpar: projectedRevpar,
      expenses: projectedExpenses,
      otaCommission: otaCommissionAmount,
      netProfit,
      margin: projectedRevenue > 0 ? netProfit / projectedRevenue : 0,
    };
  }

  static calculatePortfolioComparison(currentRows = [], previousRows = [], propertyRoomCounts = {}, properties = []) {
    const current = this.calculateOccupancyMetrics(currentRows, propertyRoomCounts);
    const previous = this.calculateOccupancyMetrics(previousRows, propertyRoomCounts);

    return {
      revenue: { current: current.revenue, previous: previous.revenue, diff: current.revenue - previous.revenue },
      roomsSold: { current: current.roomsSold, previous: previous.roomsSold, diff: current.roomsSold - previous.roomsSold },
      occupancy: { current: current.occupancy, previous: previous.occupancy, diff: current.occupancy - previous.occupancy },
      adr: { current: current.adr, previous: previous.adr, diff: current.adr - previous.adr },
      revpar: { current: current.revpar, previous: previous.revpar, diff: current.revpar - previous.revpar },
    };
  }
}

export const calculationService = new CalculationService();
export default CalculationService;