/**
 * Enhanced Web Worker CSV Parser
 */
import { parseCsvText, rowsToObjects, detectSections } from './csvParser.js';

function scanChunkedByteStream(chunks, chunkSize = 65536) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    const view = new Uint8Array(chunk);
    combined.set(view, offset);
    offset += view.byteLength;
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const src = decoder.decode(combined, { stream: true });
  return parseCsvText(src);
}

const KNOWN_HEADER_KEYWORDS = new Map([
  ['date', ['date', 'dt', 'business_date', 'snapshot']],
  ['room', ['room', 'room_number', 'rm_no', 'room_no']],
  ['folio', ['folio', 'folio_number', 'folio_no', 'guest_folio']],
  ['username', ['username', 'user', 'clerk', 'employee', 'clerk_id']],
  ['amount', ['amount', 'value', 'amt', 'total', 'net_amount']],
  ['description', ['description', 'desc', 'remarks', 'notes', 'memo']],
  ['channel', ['channel', 'source', 'booking_source', 'channel_name']],
  ['status', ['status', 'state', 'reservation_status', 'folio_status']],
]);

function inferSchema(rows) {
  if (!Array.isArray(rows) || rows.length < 1) return null;
  const headerRow = rows[0];
  if (!Array.isArray(headerRow)) return null;
  const detected = {};
  const lowerHeaders = headerRow.map((h) => String(h || '').trim().toLowerCase());
  for (const [canonical, keywords] of KNOWN_HEADER_KEYWORDS.entries()) {
    for (let i = 0; i < lowerHeaders.length; i++) {
      const cell = lowerHeaders[i];
      if (cell && keywords.some((kw) => cell === kw || cell.includes(kw))) {
        if (!detected[canonical]) detected[canonical] = i;
        break;
      }
    }
  }
  return detected;
}

self.onmessage = (e) => {
  try {
    const data = e.data || {};
    if (data.text !== undefined) {
      const text = String(data.text ?? '');
      const rows = parseCsvText(text);
      const sections = detectSections(rows);
      const objects = rowsToObjects(rows);
      const schema = inferSchema(rows);
      self.postMessage({ mode: 'text', rows, objects, sections, schema, rowCount: rows.length, detectedSchema: schema });
      return;
    }
    if (Array.isArray(data.chunks) && data.chunks.length > 0) {
      const chunks = data.chunks.map((c) => {
        if (c instanceof ArrayBuffer) return c;
        if (ArrayBuffer.isView(c)) return c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength);
        return new ArrayBuffer(0);
      }).filter((c) => c.byteLength > 0);
      if (chunks.length === 0) {
        self.postMessage({ error: 'No valid binary chunks provided.' });
        return;
      }
      const rows = scanChunkedByteStream(chunks, data.chunkSize || 65536);
      const sections = detectSections(rows);
      const objects = rowsToObjects(rows);
      const schema = inferSchema(rows);
      self.postMessage({
        mode: 'stream',
        rows, objects, sections, schema,
        rowCount: rows.length, detectedSchema: schema,
        chunksProcessed: chunks.length,
        totalBytes: chunks.reduce((sum, c) => sum + c.byteLength, 0)
      });
      return;
    }
    if (data.streamDescriptor) {
      self.postMessage({ mode: 'stream_reserved', message: 'ReadableStream descriptor received.' });
      return;
    }
    self.postMessage({ error: 'Parser worker: unknown ingestion mode.' });
  } catch (error) {
    self.postMessage({ error: error.message || 'Worker parse error' });
  }
};
