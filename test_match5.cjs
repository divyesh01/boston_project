const fs = require('fs');
const pt = fs.readFileSync('.agent-runs/last_patch_fail.txt', 'utf8').replace(/\r\n/g, '\n');
let newSource = fs.readFileSync('src/pages/MonthlyCalendar.jsx', 'utf8').replace(/\r\n/g, '\n');

let currentIndex = 0;
let matchCount = 0;
while (true) {
  const startIdx = pt.indexOf('<<<<', currentIndex);
  if (startIdx === -1) break;
  const midIdx = pt.indexOf('====', startIdx);
  if (midIdx === -1) break;
  const endIdx = pt.indexOf('>>>>', midIdx);
  if (endIdx === -1) break;
  
  let oldCodeRaw = pt.substring(startIdx + 4, midIdx);
  let oldLines = oldCodeRaw.split('\n');
  while(oldLines.length && oldLines[0].trim() === '') oldLines.shift();
  while(oldLines.length && oldLines[oldLines.length-1].trim() === '') oldLines.pop();
  let oldCode = oldLines.join('\n');
  
  let newCodeRaw = pt.substring(midIdx + 4, endIdx);
  let newLines = newCodeRaw.split('\n');
  while(newLines.length && newLines[0].trim() === '') newLines.shift();
  while(newLines.length && newLines[newLines.length-1].trim() === '') newLines.pop();
  let newCode = newLines.join('\n');
  
  if (newSource.includes(oldCode)) {
    newSource = newSource.replace(oldCode, () => newCode);
    console.log('Match!', matchCount);
    matchCount++;
  } else {
    console.log('FAIL on', matchCount);
  }
  currentIndex = endIdx + 4;
}

