import fs from 'fs';
import { parseCsvText, detectSections } from '../src/lib/csvParser.js';
import { scanAdjustmentsRefunds } from '../src/lib/reportParsers.js';

const text = fs.readFileSync('C:/Users/divye/.gemini/antigravity/brain/5d90d1ef-fdb0-47c4-910f-65d86325beb5/.user_uploaded/media_1786512688834.csv', 'utf8');
const rawRows = parseCsvText(text);

const sections = detectSections(rawRows);
console.log('Sections detected:', sections.map(s => s.type).join(', '));
const result = scanAdjustmentsRefunds(rawRows, {});
console.log('Adjustments parsed:', result.adjustments.length);
console.log('Refunds parsed:', result.refunds.length);
