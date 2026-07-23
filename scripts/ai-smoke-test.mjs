import assert from 'node:assert/strict';

const base = process.env.MULTISTREAMS_TEST_URL || 'https://multistreams.tv';
const origin = 'https://multistreams.tv';
const suffix = String(Date.now()).slice(-10);
const username = `aismoke${suffix}`;
const email = `${username}@example.test`;
const password = 'AI-smoke-password-42!';
let cookie = '';

async function request(path, { method = 'GET', body, expected = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  await request('/api/auth/signup', { method: 'POST', expected: 201, body: { email, username, password } });
  const result = await request('/api/ai/search', {
    method: 'POST',
    body: {
      contents: [{ role: 'user', parts: [{ text: 'Return a tiny JSON response confirming AI Search is online.' }] }],
      systemInstruction: 'Return only JSON with a short title and answer.',
      googleSearch: true
    }
  });
  assert.ok(['gemini-3.6-flash', 'gemini-3.5-flash-lite'].includes(result.model));
  assert.ok(result.response?.candidates?.[0]?.content?.parts?.some(part => typeof part.text === 'string' && part.text.length > 0));
  const discovery = await request('/api/ai/search', {
    method: 'POST',
    body: {
      contents: [{ role: 'user', parts: [{ text: 'Find ten top livestream creators and return the requested structured JSON without calling functions.' }] }],
      systemInstruction: 'Return only valid JSON with title, answer, resultType, profiles, clips, quickFacts, comparison, and trendGraph fields.',
      googleSearch: true
    }
  });
  assert.ok(discovery.response?.candidates?.[0]?.content?.parts?.some(part => typeof part.text === 'string' && part.text.length > 0));
  assert.notEqual(discovery.response?.candidates?.[0]?.finishReason, 'MALFORMED_FUNCTION_CALL');
  console.log(JSON.stringify({ ok: true, model: result.model, responseReceived: true, structuredSearch: true }));
} finally {
  if (cookie) await request('/api/auth/account', { method: 'DELETE', body: { confirmation: username } }).catch(() => {});
}
