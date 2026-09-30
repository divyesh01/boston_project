import {describe,it,expect} from 'vitest';
import {reconcileCash} from '@/lib/cashReconciliation';
const receipt=(date,amount,property_id='A')=>({record_type:'payment',payment_type:'CASH',date,net_today:amount,property_id});
const drop=(date,amount,property_id='A')=>({record_type:'drop',shift_date:date,amount,property_id,clerk_name:'Alice'});
describe('cash coverage',()=>{
 it('never accuses staff when deposits have no receipts',()=>{const result=reconcileCash([drop('2026-01-01',300)]);expect(result.status).toBe('Incomplete');expect(result.varianceCents).toBeNull();});
 it('requires every deposit property day to have receipts',()=>{expect(reconcileCash([receipt('2026-01-01',100),drop('2026-01-01',100),drop('2026-01-02',200)]).status).toBe('Incomplete');expect(reconcileCash([receipt('2026-01-01',100),drop('2026-01-01',100,'B')]).status).toBe('Incomplete');});
 it('preserves a proven zero receipt',()=>{expect(reconcileCash([receipt('2026-01-01',0),drop('2026-01-01',10)]).varianceCents).toBe(-1000);});
 it('does not double count report totals and clerk details',()=>{expect(reconcileCash([receipt('2026-01-01',100),{record_type:'clerk_payment',payment_type:'CASH',date:'2026-01-01',property_id:'A',clerk_name:'Alice',amount:100},drop('2026-01-01',100)]).varianceCents).toBe(0);});
});
