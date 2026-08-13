import crypto from 'crypto';
import fs from 'fs';
import { z } from 'zod';

const processedEvents = new Set();
const ipMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 50;

const WebhookSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1).optional(),
  created_at: z.string().optional(),
  data: z.record(z.any()).optional()
}).passthrough();

export function ingestWebhook(reqOrEvent) {
  const getHeader = (name) => {
    if (reqOrEvent.headers) {
      return reqOrEvent.headers[name] || reqOrEvent.headers[name.toLowerCase()] || reqOrEvent.headers[name.toUpperCase()];
    }
    if (typeof reqOrEvent.get === 'function') {
      return reqOrEvent.get(name) || reqOrEvent.get(name.toLowerCase());
    }
    return null;
  };

  // 1. Rate Limiting
  // Prefer the network-layer peer address. X-Forwarded-For is fully
  // attacker-controlled and must never be the primary key for throttling.
  const ip =
    (reqOrEvent && reqOrEvent.socket && reqOrEvent.socket.remoteAddress) ||
    getHeader('x-forwarded-for') ||
    'unknown';
  const now = Date.now();
  const times = ipMap.get(ip) || [];
  const recent = times.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) {
    throw new Error('Rate limit exceeded');
  }
  recent.push(now);
  ipMap.set(ip, recent);

  // 2. Replay Protection
  const timestamp = getHeader('x-timestamp');
  if (!timestamp) {
    throw new Error('Missing X-Timestamp header');
  }
  if (Math.abs(now - parseInt(timestamp, 10)) > 5 * 60 * 1000) {
    throw new Error('Invalid or expired timestamp');
  }
  
  // 3. Signature Verification
  const signature = getHeader('x-signature');
  if (!signature) {
    throw new Error('Missing X-Signature header');
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[WEBHOOK] Server missing WEBHOOK_SECRET environment variable');
    throw new Error('Internal server error configuration');
  }

  // Verify the HMAC over the RAW request body (buffer/string) — never over a
  // re-serialized JSON object, whose byte layout can differ from what the
  // sender signed. Fail closed if no raw body is available.
  const rawPayload = reqOrEvent.rawBody
    ? (Buffer.isBuffer(reqOrEvent.rawBody)
        ? reqOrEvent.rawBody.toString('utf8')
        : String(reqOrEvent.rawBody))
    : (typeof reqOrEvent.body === 'string' ? reqOrEvent.body : null);

  if (rawPayload === null) {
    throw new Error('Missing raw webhook body; cannot verify signature');
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawPayload)
    .digest('hex');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new Error('Invalid webhook signature');
  }

  // 4. Strict Schema Validation
  const rawEvent = reqOrEvent.body || reqOrEvent;
  const parseResult = WebhookSchema.safeParse(rawEvent);
  
  if (!parseResult.success) {
    throw new Error('Invalid event shape: ' + parseResult.error.message);
  }
  const event = parseResult.data;

  // 5. Idempotency Check
  let persistentEvents = processedEvents;
  const dbPath = './.webhook-events.json';
  try {
    if (fs.existsSync(dbPath)) {
      persistentEvents = new Set(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
    }
  } catch (e) {}

  if (persistentEvents.has(event.event_id)) {
    console.log(`[WEBHOOK] Ignored duplicate event: ${event.event_id}`);
    return { status: 'ignored', reason: 'duplicate', event_id: event.event_id };
  }
  persistentEvents.add(event.event_id);
  
  // Prevent memory leak
  if (persistentEvents.size > 10000) {
    const iterator = persistentEvents.values();
    persistentEvents.delete(iterator.next().value);
  }

  try {
    fs.writeFileSync(dbPath, JSON.stringify(Array.from(persistentEvents)));
  } catch (e) {}

  console.log(`[WEBHOOK] Received valid event: ${event.event_id}`);
  return { status: 'processed', event_id: event.event_id };
}

