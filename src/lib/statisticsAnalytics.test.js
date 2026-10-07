import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'vitest';
import * as m from './statisticsAnalytics';

// Regression fixtures prove portfolio totals, scope completeness and snapshot boundaries.
const R = (pid,name,value,extra={}) => ({id:crypto.randomUUID(), property_id:pid, business_date:'2026-10-02', metric_name:name,metric_category:'Revenue',section:'Revenue',period:'actual_today',value,original_value:String(value),unit:'currency',is_total:false,is_unknown:false,...extra});
const base = [R('A','Taxable Room Revenue',100),R('A','Exempt Room Revenue',5),R('B','Taxable Room Revenue',300),R('B','Exempt Room Revenue',7)];
const revenue = (m,r,period='actual_today',ids) => m.headline(r,period,ids).find(x=>x.key==='revenue');
const table = (m,r,name='Taxable Room Revenue',period='actual_today',ids) => m.sectionTable(r,ids).find(x=>x.name==='Revenue')?.metrics.find(x=>x.name===name)?.values[period];
const composition = (m,r,ids) => m.composition(r,'Revenue','actual_today',ids).find(x=>x.name==='Taxable Room Revenue')?.value;
const check = (name,fn) => it(name,fn);
const fixtures = {
  mixed:[R('A','Taxable Room Revenue',100),R(undefined,'Taxable Room Revenue',300)],
  partial:base.filter(r=>r.property_id==='A'),
  yoy:[...base.map(r=>({...r,period:'mtd',value:r.metric_name==='Exempt Room Revenue'?(r.property_id==='A'?25:75):r.value})),R('A','Taxable Room Revenue',75,{period:'ly_mtd'}),R('A','Exempt Room Revenue',25,{period:'ly_mtd'}),R('B','Taxable Room Revenue',225,{period:'ly_mtd'}),R('B','Exempt Room Revenue',75,{period:'ly_mtd'})],
};
/** @type {Array<[string, (module: typeof import('./statisticsAnalytics')) => void]>} */
const defectOracles = [
  ['table adds properties',m=>assert.equal(table(m,base),400)],
  ['composition mixed scope unknown',m=>assert.equal(composition(m,fixtures.mixed),null)],
  ['room total YoY25%',m=>assert.equal(revenue(m,fixtures.yoy,'mtd').change?.pct,25)],
  ['selected missing property unknown',m=>assert.equal(revenue(m,fixtures.partial,'actual_today',['A','B']).value,null)],
  ['room total trend412',m=>assert.equal(m.headlineTrends(base,['A','B']).revenue[0].value,412)],
];

describe('portfolio snapshot statistics', () => {
  for(const [name,fn] of defectOracles)check(name,()=>fn(m));
  check('individual A105/B307',()=>{assert.equal(revenue(m,fixtures.partial,'actual_today','A').value,105);assert.equal(revenue(m,base.filter(r=>r.property_id==='B'),'actual_today','B').value,307);});
  check('portfolio total cents41200',()=>{assert.equal(Math.round(revenue(m,base).value*100),41200);assert.equal(table(m,base,'Exempt Room Revenue'),12);assert.equal(m.revenueSplit(base,'actual_today').room,412);});
  check('composition total400 and12',()=>{assert.deepEqual(m.composition(base,'Revenue').map(x=>x.value),[400,12]);});
  check('selected missing property every surface unknown',()=>{const ids=['A','B'];assert.equal(revenue(m,fixtures.partial,'actual_today',ids).incomplete,true);assert.equal(table(m,fixtures.partial,'Taxable Room Revenue','actual_today',ids),null);assert.equal(composition(m,fixtures.partial,ids),null);assert.equal(m.revenueSplit(fixtures.partial,'actual_today',ids).total,null);});
  check('empty selection rejects stray rows',()=>assert.equal(revenue(m,base,'actual_today',[]).value,null));
  check('unexpected property rejects scope',()=>assert.equal(revenue(m,base,'actual_today','A').value,null));
  check('same property duplicate last row wins',()=>{const r=[R('A','Taxable Room Revenue',99),...base];assert.equal(revenue(m,r).value,412);assert.equal(table(m,r),400);assert.equal(composition(m,r),400);});
  check('single duplicate remains last row',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue',99),R('A','Taxable Room Revenue',100)]).value,100));
  check('typed IDs numeric1 vs string1',()=>assert.equal(revenue(m,[R(1,'Taxable Room Revenue',100),R('1','Taxable Room Revenue',300)]).value,400));
  check('numeric zero identity valid',()=>assert.equal(revenue(m,[R(0,'Taxable Room Revenue',100),R('B','Taxable Room Revenue',300)],'actual_today',[0,'B']).value,400));
  check('raw strings remain distinct',()=>assert.equal(revenue(m,[R('1','Taxable Room Revenue',100),R(' 1','Taxable Room Revenue',300)]).value,400));
  check('whitespace identity invalid',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue',100),R(' ','Taxable Room Revenue',300)]).value,null));
  check('all missing legacy unchanged',()=>{const r=fixtures.mixed.map(x=>({...x,property_id:undefined}));assert.deepEqual(m.composition(r,'Revenue'),[{name:'Taxable Room Revenue',value:300},{name:'Taxable Room Revenue',value:100}]);assert.equal(m.sectionTable(r)[0].metrics[0].values.actual_today,300);assert.equal(revenue(m,r).value,300);assert.equal(revenue(m,r,'actual_today',['A']).value,null);});
  check('currency cent arithmetic',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue',.1),R('B','Taxable Room Revenue',.2)]).value,.3));
  check('valid zero counts as known',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue',0),R('B','Taxable Room Revenue',0)]).value,0));
  check('negative amounts remain signed',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue',-5),R('B','Taxable Room Revenue',2)]).value,-3));
  check('missing exempt subset unknown',()=>assert.equal(revenue(m,base.filter(r=>r.id!==base[3].id)).value,null));
  check('absent all exempt legs permit zero',()=>assert.equal(revenue(m,base.filter(r=>r.metric_name==='Taxable Room Revenue')).value,400));
  check('missing metric one property unknown',()=>{const r=[R('A','Taxable Room Revenue',100),R('B','Total Guests',7,{unit:'count'})];assert.equal(revenue(m,r).value,null);assert.equal(table(m,r),null);});
  check('malformed currency unknown',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue','bad'),R('B','Taxable Room Revenue',300)]).value,null));
  check('single malformed revenue unknown',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue','bad')]).value,null));
  check('rates require weights',()=>{const r=[R('A','ADR',100),R('B','ADR',200)];assert.equal(m.headline(r).find(x=>x.key==='adr').value,null);assert.equal(table(m,r,'ADR'),null);assert.equal(m.composition(r,'Revenue')[0].value,null);});
  check('count aliases per property once',()=>{const r=[R('A','Room Sold',2,{unit:'count'}),R('A','Rooms Sold Excluding Comp House Use Rooms',99,{unit:'count'}),R('B','Rooms Sold Excluding Comp House Use Rooms',3,{unit:'count'})];assert.equal(m.headline(r).find(x=>x.key==='sold').value,5);});
  check('latest date only single',()=>assert.equal(revenue(m,[R('A','Taxable Room Revenue',300,{business_date:'2026-10-01'}),R('A','Taxable Room Revenue',100)]).value,100));
  check('latest date missing inferred property unknown',()=>assert.equal(revenue(m,[R('B','Taxable Room Revenue',300,{business_date:'2026-10-01'}),R('A','Taxable Room Revenue',100)]).value,null));
  check('periods remain independent',()=>{const r=[...base,...base.map(x=>({...x,period:'mtd',value:x.value*2}))];assert.equal(revenue(m,r).value,412);assert.equal(revenue(m,r,'mtd').value,824);});
  check('room total YoY now then delta',()=>assert.deepEqual(revenue(m,fixtures.yoy,'mtd').change,{now:500,then:400,delta:100,pct:25}));
  check('single YoY includes exempt',()=>assert.deepEqual(revenue(m,fixtures.yoy.filter(x=>x.property_id==='A'),'mtd').change,{now:125,then:100,delta:25,pct:25}));
  check('missing prior suppresses comparison',()=>assert.equal(revenue(m,fixtures.yoy.filter(x=>x.period!=='ly_mtd'),'mtd').change,null));
  check('zero prior suppresses comparison',()=>assert.equal(revenue(m,fixtures.yoy.map(x=>x.period==='ly_mtd'?{...x,value:0}:x),'mtd').change,null));
  check('section totals preserved not doublecounted',()=>{const r=[...base,R('A','Revenue total',105,{is_total:true}),R('B','Revenue total',307,{is_total:true})];assert.equal(revenue(m,r).value,412);assert.equal(table(m,r,'Revenue total'),412);assert.equal(m.sectionTable(r)[0].metrics.find(x=>x.name==='Revenue total').isTotal,true);});
  check('portfolio original not one property text',()=>assert.equal(m.sectionTable(base)[0].metrics.find(x=>x.name==='Taxable Room Revenue').originals.actual_today,null));
  check('trend individual A105 B307 portfolio412',()=>{assert.equal(m.headlineTrends(fixtures.partial,'A').revenue[0].value,105);assert.equal(m.headlineTrends(base.filter(x=>x.property_id==='B'),'B').revenue[0].value,307);assert.equal(m.headlineTrends(base,['A','B']).revenue[0].value,412);});
  check('trend missing property date null no carry-forward',()=>{const r=[...base,...fixtures.partial.map(x=>({...x,business_date:'2026-10-01'}))];assert.deepEqual(m.headlineTrends(r,['A','B']).revenue,[{date:'2026-10-01',value:null},{date:'2026-10-02',value:412}]);});
  check('legacy trend unchanged',()=>{const r=base.map(x=>({...x,property_id:undefined}));assert.equal(m.headlineTrends(r).revenue[0].value,100);});
  check('input records unchanged',()=>{const original=JSON.stringify(base);m.headline(base);m.sectionTable(base);m.composition(base,'Revenue');m.revenueSplit(base,'actual_today');m.headlineTrends(base);assert.equal(JSON.stringify(base),original);});
});
