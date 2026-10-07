const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const twilio = require('twilio');
const handler = require('../api/sms');

const TOKEN = 'dummy-twilio-auth-token';
const URL = 'https://theapexworks.com/api/sms';
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

const ENV_KEYS = [
  'TWILIO_AUTH_TOKEN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'FORWARD_WEBHOOK_URL',
];

// Twilio's webhook signature: HMAC-SHA1 (base64) over the full URL plus
// POST params sorted by name and concatenated as name + value.
function twilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const value = params[key];
      if (Array.isArray(value)) {
        return acc + value.slice().sort().map((item) => key + item).join('');
      }
      return acc + key + value;
    }, url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(body) {
      this.body = body == null ? '' : String(body);
    },
  };
}

function baseParams(overrides = {}) {
  return {
    From: '+15551212',
    To: '+15557654',
    Body: 'Hello & world',
    MessageSid: 'SM123',
    NumMedia: '0',
    ...overrides,
  };
}

async function post(params, { signature, url = '/api/sms', token = TOKEN } = {}) {
  if (token) process.env.TWILIO_AUTH_TOKEN = token;
  const signedUrl = handler.validationUrl({ url });
  const sig = signature === undefined ? twilioSignature(token || TOKEN, signedUrl, params) : signature;
  const req = {
    method: 'POST',
    url,
    headers: {},
    body: params,
  };
  if (signature !== null) req.headers['x-twilio-signature'] = sig;
  const res = mockRes();
  await handler(req, res);
  return res;
}

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
  for (const key of ENV_KEYS) delete process.env[key];
  global.fetch = async () => {
    throw new Error('unexpected fetch');
  };
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of ENV_KEYS) delete process.env[key];
});

test('independent HMAC matches twilio.validateRequest for the public webhook URL', () => {
  const params = baseParams();
  const signature = twilioSignature(TOKEN, URL, params);
  assert.equal(twilio.validateRequest(TOKEN, signature, URL, params), true);
  assert.equal(twilio.validateRequest(TOKEN, signature, 'https://www.theapexworks.com/api/sms', params), false);
  assert.equal(twilio.validateRequest(TOKEN, signature, 'http://theapexworks.com/api/sms', params), false);
  assert.equal(twilio.validateRequest(TOKEN, signature, 'https://theapexworks.com/api/sms/', params), false);
});

test('missing TWILIO_AUTH_TOKEN fails closed with 403', async () => {
  const params = baseParams();
  const signature = twilioSignature(TOKEN, URL, params);
  const res = mockRes();
  await handler({
    method: 'POST',
    url: '/api/sms',
    headers: { 'x-twilio-signature': signature },
    body: params,
  }, res);
  assert.equal(res.statusCode, 403);
});

test('unsigned POST is rejected with 403', async () => {
  const res = await post(baseParams(), { signature: null });
  assert.equal(res.statusCode, 403);
});

test('bad signature is rejected with 403', async () => {
  const res = await post(baseParams(), { signature: 'not-a-valid-signature' });
  assert.equal(res.statusCode, 403);
});

test('signed POST returns empty TwiML and does not auto-reply', async () => {
  const res = await post(baseParams());
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/xml');
  assert.equal(res.body, EMPTY_TWIML);
  assert.doesNotMatch(res.body, /<Message/);
});

test('signature must be for https://theapexworks.com/api/sms exactly', async () => {
  const params = baseParams();
  const wwwSig = twilioSignature(TOKEN, 'https://www.theapexworks.com/api/sms', params);
  const res = await post(params, { signature: wwwSig });
  assert.equal(res.statusCode, 403);
});

test('query string is part of the signed URL', async () => {
  const params = baseParams();
  const withQuery = await post(params, { url: '/api/sms?foo=1' });
  assert.equal(withQuery.statusCode, 200);

  const signedWithoutQuery = twilioSignature(TOKEN, URL, params);
  const missingQuery = await post(params, { url: '/api/sms?foo=1', signature: signedWithoutQuery });
  assert.equal(missingQuery.statusCode, 403);
});

test('urlencoded body with plus signs is signed using decoded values', async () => {
  const params = baseParams({ Body: 'Hello world' });
  const signature = twilioSignature(TOKEN, URL, params);
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  const res = mockRes();
  await handler({
    method: 'POST',
    url: '/api/sms',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    },
    body: 'From=%2B15551212&To=%2B15557654&Body=Hello+world&MessageSid=SM123&NumMedia=0',
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, EMPTY_TWIML);
});

test('stores a new message, emails Damon, and posts the optional hook', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/rest/v1/apex_sms_inbound')) {
      return new Response(JSON.stringify([{ sid: 'SM123' }]), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  };

  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Apex Works <sms@theapexworks.com>';
  process.env.FORWARD_WEBHOOK_URL = 'https://hooks.example/sms';

  const params = baseParams({
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/0',
    Body: 'See photo',
  });
  const res = await post(params);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, EMPTY_TWIML);
  assert.equal(calls.length, 3);

  const stored = JSON.parse(calls[0].options.body);
  assert.equal(stored.sid, 'SM123');
  assert.equal(stored.from, '+15551212');
  assert.deepEqual(stored.media_urls, ['https://api.twilio.com/media/0']);
  assert.equal(calls[0].options.headers.apikey, 'service-role-test');
  assert.match(calls[0].options.headers.Prefer, /ignore-duplicates/);

  const email = JSON.parse(calls[1].options.body);
  assert.equal(email.subject, 'SMS from +15551212');
  assert.deepEqual(email.to, ['damon@theapexworks.com']);
  assert.equal(email.from, 'Apex Works <sms@theapexworks.com>');
  assert.match(email.text, /^See photo/);
  assert.match(email.text, /https:\/\/api\.twilio\.com\/media\/0/);
  assert.match(email.text, /Received: .+\bP[DS]T\b/);
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'sms/SM123');

  const hook = JSON.parse(calls[2].options.body);
  assert.equal(hook.sid, 'SM123');
  assert.equal(hook.body, 'See photo');
  assert.equal(calls[2].options.redirect, 'manual');
});

test('duplicate sid does not send email or call the hook', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(String(url));
    assert.match(String(url), /apex_sms_inbound/);
    return new Response('[]', { status: 200, headers: options.headers });
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'sms@theapexworks.com';
  process.env.FORWARD_WEBHOOK_URL = 'https://hooks.example/sms';

  const res = await post(baseParams({ MessageSid: 'SM_DUP' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    'https://kolahmdxqsgnfljuaquz.supabase.co/rest/v1/apex_sms_inbound?on_conflict=sid',
  ]);
});

test('storage and hook failures still return empty TwiML', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('supabase.co')) {
      return new Response('{"message":"relation missing"}', { status: 404 });
    }
    if (String(url).includes('api.resend.com')) {
      return new Response('{}', { status: 200 });
    }
    throw new Error('hook down');
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'sms@theapexworks.com';
  process.env.FORWARD_WEBHOOK_URL = 'https://hooks.example/sms';

  const res = await post(baseParams());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, EMPTY_TWIML);
});

test('SNAPSHOT is handled exactly like START', async () => {
  const expected = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${handler.OPT_IN_CONFIRMATION.replace(/&/g, '&amp;')}</Message></Response>`;
  for (const body of ['SNAPSHOT', 'snapshot', '  Snapshot  ', 'START', 'start', ' Start ']) {
    const res = await post(baseParams({ Body: body, MessageSid: `SM_${body.trim()}` }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/xml');
    assert.equal(res.body, expected);
  }
});

test('STOP and HELP stay empty TwiML so Twilio can send its defaults', async () => {
  for (const body of ['STOP', 'stop', 'HELP', 'help', ' Stop ']) {
    const res = await post(baseParams({ Body: body, MessageSid: `SM_${body.trim()}` }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, EMPTY_TWIML);
    assert.doesNotMatch(res.body, /<Message/);
  }
});

test('non-POST is rejected', async () => {
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/sms', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});
