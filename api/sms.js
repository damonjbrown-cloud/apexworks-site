const twilio = require('twilio');

// Twilio signs the exact public URL it was given. Behind Vercel, req.url and
// the Host / X-Forwarded-* headers are not that URL (proxy host, rewritten
// path, or http). This route is the canonical non-www webhook and must not
// be validated against anything else.
const PUBLIC_WEBHOOK_URL = 'https://theapexworks.com/api/sms';
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const DEFAULT_SUPABASE_URL = 'https://kolahmdxqsgnfljuaquz.supabase.co';
const EMAIL_TO = 'damon@theapexworks.com';

const pacificTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

function header(req, name) {
  const headers = (req && req.headers) || {};
  const value = headers[name] || headers[name.toLowerCase()] || '';
  return Array.isArray(value) ? value[0] || '' : String(value);
}

function validationUrl(req) {
  const raw = req && typeof req.url === 'string' ? req.url : '';
  const queryAt = raw.indexOf('?');
  if (queryAt === -1) return PUBLIC_WEBHOOK_URL;
  return PUBLIC_WEBHOOK_URL + raw.slice(queryAt);
}

function normalizeParams(obj) {
  const params = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (Array.isArray(value)) {
      params[key] = value.map((item) => (item == null ? '' : String(item)));
    } else if (value == null) {
      params[key] = '';
    } else {
      params[key] = String(value);
    }
  }
  return params;
}

function parseForm(raw) {
  const params = {};
  const search = new URLSearchParams(raw || '');
  for (const [key, value] of search.entries()) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const existing = params[key];
      params[key] = Array.isArray(existing) ? existing.concat(value) : [existing, value];
    } else {
      params[key] = value;
    }
  }
  return params;
}

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readParams(req) {
  const body = req ? req.body : undefined;
  if (Buffer.isBuffer(body)) return parseForm(body.toString('utf8'));
  if (typeof body === 'string') return parseForm(body);
  if (body && typeof body === 'object') return normalizeParams(body);
  if (req && typeof req.on === 'function' && req.readable !== false && !req.readableEnded) {
    return parseForm(await readStream(req));
  }
  return {};
}

function mediaUrlsFrom(params) {
  const count = Number.parseInt(params.NumMedia || '0', 10);
  const urls = [];
  const limit = Number.isFinite(count) && count > 0 ? count : 0;
  for (let i = 0; i < limit; i += 1) {
    const url = params[`MediaUrl${i}`];
    if (url) urls.push(url);
  }
  return urls;
}

function formatPacific(date) {
  return pacificTime.format(date);
}

function emailText(message) {
  const lines = [message.body || ''];
  if (message.mediaUrls.length) {
    lines.push('', 'Media:', ...message.mediaUrls);
  }
  lines.push('', `Received: ${formatPacific(message.receivedAt)}`);
  return lines.join('\n');
}

function subjectFor(from) {
  const safe = String(from || '').replace(/[\r\n]+/g, ' ').trim();
  return `SMS from ${safe}`;
}

function supabaseOrigin() {
  const raw = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) return '';
  return url.origin;
}

async function storeMessage(message) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!key) {
    console.error('sms webhook: storage skipped, SUPABASE_SERVICE_ROLE_KEY is not set', message.sid);
    return 'failed';
  }
  if (!message.sid) {
    console.error('sms webhook: storage skipped, missing MessageSid');
    return 'failed';
  }
  const origin = supabaseOrigin();
  if (!origin) {
    console.error('sms webhook: storage skipped, SUPABASE_URL is not an https supabase host', message.sid);
    return 'failed';
  }

  try {
    const response = await fetch(`${origin}/rest/v1/apex_sms_inbound?on_conflict=sid`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        body: message.body,
        media_urls: message.mediaUrls,
        sid: message.sid,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 409) return 'duplicate';

    const text = await response.text();
    if (!response.ok) {
      console.error('sms webhook: storage failed', message.sid, response.status);
      return 'failed';
    }
    if (!text) return 'inserted';

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 'inserted';
    }
    if (Array.isArray(parsed)) return parsed.length > 0 ? 'inserted' : 'duplicate';
    return 'inserted';
  } catch (err) {
    console.error('sms webhook: storage failed', message.sid, err && err.message);
    return 'failed';
  }
}

async function sendEmail(message) {
  const apiKey = process.env.RESEND_API_KEY || '';
  const fromAddress = (process.env.RESEND_FROM || '').trim();
  if (!apiKey || !fromAddress) {
    console.error('sms webhook: email skipped, RESEND_API_KEY or RESEND_FROM is not set', message.sid);
    return;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(message.sid ? { 'Idempotency-Key': `sms/${message.sid}` } : {}),
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [EMAIL_TO],
        subject: subjectFor(message.from),
        text: emailText(message),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.error('sms webhook: email failed', message.sid, response.status);
    }
  } catch (err) {
    console.error('sms webhook: email failed', message.sid, err && err.message);
  }
}

function forwardTarget() {
  const raw = (process.env.FORWARD_WEBHOOK_URL || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString();
  } catch {
    console.error('sms webhook: FORWARD_WEBHOOK_URL is not a valid http(s) URL');
    return '';
  }
}

async function forwardHook(message) {
  const target = forwardTarget();
  if (!target) return;

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        body: message.body,
        media_urls: message.mediaUrls,
        sid: message.sid,
        received_at: message.receivedAt.toISOString(),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      console.error('sms webhook: forward hook failed', message.sid, response.status);
    }
  } catch (err) {
    console.error('sms webhook: forward hook failed', message.sid, err && err.message);
  }
}

async function processInbound(message) {
  const stored = await storeMessage(message);
  if (stored === 'duplicate') {
    console.log('sms webhook: duplicate sid, not forwarding', message.sid);
    return;
  }
  await sendEmail(message);
  await forwardHook(message);
}

function forbidden(res) {
  res.statusCode = 403;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Forbidden');
}

async function handler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'text/plain');
    res.end('Method Not Allowed');
    return;
  }

  const token = process.env.TWILIO_AUTH_TOKEN || '';
  if (!token) {
    console.error('sms webhook: rejected, TWILIO_AUTH_TOKEN is not set');
    forbidden(res);
    return;
  }

  let params;
  try {
    params = await readParams(req);
  } catch (err) {
    console.error('sms webhook: rejected, unreadable body', err && err.message);
    forbidden(res);
    return;
  }

  const signature = header(req, 'x-twilio-signature');
  const url = validationUrl(req);
  let valid = false;
  try {
    valid = Boolean(signature) && twilio.validateRequest(token, signature, url, params);
  } catch (err) {
    console.error('sms webhook: signature check failed', err && err.message);
    valid = false;
  }
  if (!valid) {
    console.error('sms webhook: rejected invalid signature', header(req, 'host'));
    forbidden(res);
    return;
  }

  try {
    await processInbound({
      from: params.From || '',
      to: params.To || '',
      body: params.Body || '',
      sid: params.MessageSid || '',
      mediaUrls: mediaUrlsFrom(params),
      receivedAt: new Date(),
    });
  } catch (err) {
    console.error('sms webhook: processing failed', params.MessageSid || '', err && err.message);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/xml');
  res.end(EMPTY_TWIML);
}

module.exports = handler;
module.exports.PUBLIC_WEBHOOK_URL = PUBLIC_WEBHOOK_URL;
module.exports.validationUrl = validationUrl;
