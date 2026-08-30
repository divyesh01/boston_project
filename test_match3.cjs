const fs = require('fs');
const pt = fs.readFileSync('.agent-runs/last_patch_fail.txt', 'utf8');
let s = pt.indexOf('<<<<');
let m = pt.indexOf('====', s);
let o = pt.substring(s+4, m);
let l = o.split(/\r?\n/);
while(l.length && l[0].trim()==='') l.shift();
while(l.length && l[l.length-1].trim()==='') l.pop();
o = l.join('\n');
console.log('Opus block length:', o.length);

let src = fs.readFileSync('src/pages/MonthlyCalendar.jsx', 'utf8').replace(/\r\n/g, '\n');
let idx = src.indexOf(o);
console.log('Exact Match Index:', idx);

