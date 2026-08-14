import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStatusRoute } from '../src/routes/status.js';

test('status route merges monitor and response keys without exposing credentials', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = String(init?.body || '');
    calls.push(body);
    const isResponseKey = body.includes('response-key');
    return new Response(JSON.stringify({
      stat: 'ok',
      monitors: [{
        id: 42,
        friendly_name: 'Multistreams.tv',
        url: 'https://multistreams.tv',
        status: 2,
        custom_uptime_ratio: '99.99',
        response_times: isResponseKey ? [
          { datetime: 1700000000, value: 321 },
          { datetime: 1700000300, value: 123 }
        ] : [],
        logs: isResponseKey ? [{ id: 9, type: 1, datetime: 1699990000, duration: 60, reason: { detail: 'Timeout' } }] : []
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const request = new Request('https://multistreams.tv/api/status');
    const response = await handleStatusRoute(request, {
      APP_ORIGIN: 'https://multistreams.tv',
      UPTIMEROBOT_API_KEY: 'monitor-key',
      UPTIMEROBOT_RESPONSE_API_KEY: 'response-key'
    }, new URL(request.url));
    const payload = await response.json();
    assert.equal(calls.length, 2);
    assert.equal(payload.source, 'uptimerobot');
    assert.equal(payload.services.length, 1);
    assert.equal(payload.services[0].responseTime, 123);
    assert.equal(payload.services[0].latestCheck, '2023-11-14T22:18:20.000Z');
    assert.equal(payload.services[0].incidents[0].reason, 'Timeout');
    assert.equal(payload.services[0].history.length, 30);
    assert.equal(payload.services[0].history.at(-1).responseTime, 123);
    assert.doesNotMatch(JSON.stringify(payload), /monitor-key|response-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('status route keeps real UptimeRobot data when one configured key fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (String(init?.body || '').includes('bad-key')) return new Response('{"stat":"fail"}', { status: 401 });
    return new Response(JSON.stringify({
      stat: 'ok',
      monitors: [{ id: 7, friendly_name: 'API', url: 'https://multistreams.tv/api/health', status: 2 }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const request = new Request('https://multistreams.tv/api/status');
    const response = await handleStatusRoute(request, {
      APP_ORIGIN: 'https://multistreams.tv',
      UPTIMEROBOT_API_KEY: 'good-key',
      UPTIMEROBOT_RESPONSE_API_KEY: 'bad-key'
    }, new URL(request.url));
    const payload = await response.json();
    assert.equal(payload.source, 'uptimerobot');
    assert.equal(payload.services[0].name, 'API');
    assert.match(payload.warning, /temporarily unavailable/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
