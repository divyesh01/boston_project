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
let idx = src.indexOf('className={min-h-[90px]');
console.log('Found index in src:', idx);

let sPart = src.substring(idx - 18, idx - 18 + o.length);
console.log('Is exactly equal?', sPart === o);
if (sPart !== o) {
    for (let i = 0; i < o.length; i++) {
        if (sPart[i] !== o[i]) {
            console.log('Mismatch at', i, 'src:', sPart.charCodeAt(i), 'o:', o.charCodeAt(i));
            break;
        }
    }
}

