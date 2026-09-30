import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('@/lib/commissionRates',async importOriginal=>({...await importOriginal(),getCcFeeRate:()=>0.03,getCcFeeOnRefunds:()=>true}));
import {CalculationService} from '@/lib/calculationService';
import {aggregateDays,buildSyntheticRows} from '@/lib/dailyAggregates';
import {buildPricingForecast} from '@/lib/pricingEngine';
import {parseWorkbookInWorker} from '@/lib/workbookParser';
const date='2026-01-01';
const occ=['A','B'].map(property_id=>({property_id,date,room_revenue:100,rooms_sold:1,total_rooms:10}));
const pay=['A','B'].map(property_id=>({property_id,date,visa:100,total:100}));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('takeover financial invariants',()=>{
 for(const amount of [1,0,-1]) it(`keeps B estimated fee when A actual is ${amount}`,()=>{
  const result=CalculationService.calculateMoneyKept(occ,[],[],pay,[{property_id:'A',expense_date:date,category:'credit_card_fees',amount}],[],{from:date,to:date},'all');
  expect(result.ccFees).toBe(amount+3);
 });
 it('preserves zero-tax reports, channel refunds and unavailable inventory through cache',()=>{
  const raw={occ:[{...occ[0],down_rooms:2}],src:[{property_id:'A',date,source:'EXPEDIA',net_revenue:100,stays:1,refunds:10}],gross:[{property_id:'A',date,room_rent:0,state_tax:0,city_tax:0,other_tax:0}],pay:[pay[0]]};
  const rows=buildSyntheticRows(aggregateDays(raw));
  expect(rows.grossRows).toHaveLength(1);expect(rows.srcRows[0].refunds).toBe(10);expect(rows.occRows[0].out_of_order).toBe(2);
  expect(CalculationService.calculateTaxLiability(rows.srcRows,rows.grossRows,'A',{from:date,to:date}).estimated).toBe(0);
  expect(CalculationService.calculateChannelMetrics(rows.srcRows)[0].netContribution).toBe(CalculationService.calculateChannelMetrics(raw.src)[0].netContribution);
 });
 it('keeps refund and reversal timing when period total nets to zero',()=>{
  const result=CalculationService.calculateRefunds([{property_id:'A',date,closed_balance_folio:-50},{property_id:'A',date:'2026-01-02',closed_balance_folio:50}]);
  expect(result.refundsCents).toBe(0);expect(result.daily.map(r=>r.refundsCents)).toEqual([5000,-5000]);
 });
 it('has no pricing forecast without inventory and zero revenue without bookings',()=>{
  expect(buildPricingForecast({rooms:[],reservations:[],config:{},fromDate:date})).toEqual([]);
  const rooms=[{room_type:'a'},{room_type:'a'},{room_type:'a'},{room_type:'b'}];
  const [row]=buildPricingForecast({rooms,reservations:[],config:{baseRates:{a:10000,b:20000}},days:1,fromDate:date});
  expect(row.projectedRevenueCents).toBe(0);expect(row.projectedRoomNights).toBe(0);expect(row.baseAdrCents).toBe(12500);
 });
 it('terminates a stalled workbook worker at the timeout',async()=>{
  vi.useFakeTimers();const terminate=vi.fn();vi.stubGlobal('Worker',class {terminate=terminate;postMessage() {}});
  const result=parseWorkbookInWorker(new Uint8Array([1]));const rejected=expect(result).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(30000);await rejected;expect(terminate).toHaveBeenCalledOnce();
 });
});
