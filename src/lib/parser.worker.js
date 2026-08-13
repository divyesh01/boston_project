import { parseCsvText } from './csvParser.js';

self.onmessage = (e) => {
  try {
    const { text } = e.data;
    const rows = parseCsvText(text);
    self.postMessage({ rows });
  } catch (error) {
    self.postMessage({ error: error.message || 'Worker parse error' });
  }
};
