import { toCents, fromCents } from './decimal.js';

export function calculatePromotionStack({ nightly_rate, discounts = [], commission_rate = 0, card_rate = 0, break_even = 0 }) {
  const validate = (n, max, label) => { if (!Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > max) throw new Error(`Invalid ${label}.`); return Number(n); };
  let cents = toCents(validate(nightly_rate, 1000000, 'nightly rate'));
  const listedCents = cents, steps = [];
  for (const discount of discounts) {
    const rate = validate(discount.rate, 1, 'promotion rate');
    const deduction = Math.round(cents * rate);
    cents -= deduction;
    steps.push({ name: discount.name, rate, deduction: fromCents(deduction), remaining: fromCents(cents) });
  }
  const commission = Math.round(cents * validate(commission_rate, 1, 'commission rate'));
  const card = Math.round(cents * validate(card_rate, 1, 'card fee rate'));
  const net = cents - commission - card;
  const breakEven = toCents(validate(break_even, 1000000, 'break-even cost'));
  return { listed: fromCents(listedCents), discounted: fromCents(cents), steps, commission: fromCents(commission), card: fromCents(card), net: fromCents(net), contribution: fromCents(net - breakEven), belowBreakEven: net < breakEven };
}
