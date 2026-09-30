import {describe,it,expect} from 'vitest';
import * as XLSX from 'xlsx';
import {workbookToCsv} from '@/lib/workbookParser';
const bytes=sheet=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Report');return XLSX.write(book,{type:'array',bookType:'xlsx'});};
describe('bounded workbook import',()=>{
 it('preserves negative amounts and dates',async()=>{const csv=await workbookToCsv(bytes(XLSX.utils.aoa_to_sheet([['date','amount'],['2026-01-01',-12.5]])));expect(csv).toContain('-12.5');expect(csv).toContain('2026-01-01');});
 it('rejects oversized declared dimensions',async()=>{const sheet=XLSX.utils.aoa_to_sheet([['date']]);sheet['!ref']='A1:IZ1';await expect(workbookToCsv(bytes(sheet))).rejects.toThrow('dimensions');});
});
