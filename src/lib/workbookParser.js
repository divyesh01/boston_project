import * as XLSX from 'xlsx';
export const MAX_WORKBOOK_ROWS = 200000;
export const MAX_WORKBOOK_COLUMNS = 256;
export const MAX_WORKBOOK_CELLS = 2000000;
export async function workbookToCsv(bytes) {
  if (!bytes || bytes.byteLength > 50 * 1024 * 1024) throw new Error('Workbook exceeds import size limit');

  const book = XLSX.read(bytes,{type:'array',cellDates:true,sheetRows:MAX_WORKBOOK_ROWS+1});
  if (book.SheetNames.length !== 1) throw new Error('Select a single-sheet report before importing; multiple sheets are not silently skipped');
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error('Workbook contains no sheets');
  const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
  const rows = range.e.r+1, columns = range.e.c+1;
  if (rows>MAX_WORKBOOK_ROWS || columns>MAX_WORKBOOK_COLUMNS || rows*columns>MAX_WORKBOOK_CELLS) throw new Error('Workbook dimensions exceed import limits');
  return XLSX.utils.sheet_to_csv(sheet,{dateNF:'yyyy-mm-dd'});
}
export function parseWorkbookInWorker(bytes) {
  if (!bytes || bytes.byteLength > 50 * 1024 * 1024) return Promise.reject(new Error('Workbook exceeds import size limit'));
  return new Promise((resolve,reject)=>{
    const worker = new Worker(new URL('./workbook.worker.js',import.meta.url),{type:'module'});
    const finish = (error,csv) => {clearTimeout(timer);worker.terminate();if(error) reject(new Error(error));else resolve(csv);};
    const timer = setTimeout(()=>finish('Workbook parsing timed out'),30000);
    worker.onmessage = event=>finish(event.data.error,event.data.csv);
    worker.onerror = event=>finish(event.message || 'Workbook parsing failed');
    worker.postMessage({bytes});
  });
}
