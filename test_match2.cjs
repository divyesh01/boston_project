const fs = require('fs');
let src = fs.readFileSync('src/pages/MonthlyCalendar.jsx', 'utf8').replace(/\r\n/g, '\n');
let lines = src.split('\n');
console.log(lines[300]);
console.log(lines[300].indexOf('className'));

