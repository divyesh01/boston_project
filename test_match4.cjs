const fs = require('fs');
const pt = fs.readFileSync('.agent-runs/last_patch_fail.txt', 'utf8').replace(/\r\n/g, '\n');
let src = fs.readFileSync('src/pages/MonthlyCalendar.jsx', 'utf8').replace(/\r\n/g, '\n');

let ci = 0;
while(true) {
  let s = pt.indexOf('<<<<', ci);
  if(s===-1)break;
  let m = pt.indexOf('====', s);
  if(m===-1)break;
  let e = pt.indexOf('>>>>', m);
  if(e===-1)break;

  let o = pt.substring(s+4, m);
  let l = o.split('\n');
  while(l.length && l[0].trim()==='') l.shift();
  while(l.length && l[l.length-1].trim()==='') l.pop();
  o = l.join('\n');

  console.log('--- Block ---');
  console.log(o.substring(0, 50));
  let idx = src.indexOf(o);
  console.log('Exact Match Index:', idx);
  if (idx === -1) {
     console.log('FAIL');
  }

  ci = e + 4;
}

