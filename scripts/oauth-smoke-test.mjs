import assert from 'node:assert/strict';

const base = process.env.MULTISTREAMS_TEST_URL || 'https://multistreams.tv';
const origin = 'https://multistreams.tv';
const suffix = String(Date.now()).slice(-10);
const username = `oauthsmoke${suffix}`;
const email = `${username}@example.test`;
const password = 'OAuth-smoke-password-42!';
let cookie = '';

async function jsonRequest(path, { method = 'GET', body, expected = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function oauthLocation(path) {
  const response = await fetch(`${base}${path}`, { headers: { origin, cookie }, redirect: 'manual' });
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location'));
}

try {
  await jsonRequest('/api/auth/signup', { method: 'POST', expected: 201, body: { email, username, password } });

  const youtube = await oauthLocation('/api/oauth/google/start?purpose=youtube-connect&returnTo=/multistreams');
  assert.equal(youtube.hostname, 'accounts.google.com');
  assert.equal(youtube.searchParams.get('redirect_uri'), 'https://multistreams.tv/api/oauth/google/callback');
  assert.match(youtube.searchParams.get('scope') || '', /youtube\.readonly/);
  assert.equal(youtube.searchParams.get('prompt'), 'consent');
  assert.equal(youtube.searchParams.get('code_challenge_method'), 'S256');

  const twitch = await oauthLocation('/api/oauth/twitch/start?returnTo=/multistreams');
  assert.equal(twitch.hostname, 'id.twitch.tv');
  assert.equal(twitch.searchParams.get('redirect_uri'), 'https://multistreams.tv/api/oauth/twitch/callback');
  assert.match(twitch.searchParams.get('scope') || '', /user:read:follows/);
  assert.equal(twitch.searchParams.get('force_verify'), 'true');
  assert.equal(twitch.searchParams.get('code_challenge_method'), 'S256');

  for (const providerUrl of [youtube, twitch]) {
    const response = await fetch(providerUrl, { redirect: 'manual' });
    assert.ok([200, 302, 303].includes(response.status), `${providerUrl.hostname} rejected the authorization request with ${response.status}`);
    assert.doesNotMatch(response.headers.get('location') || '', /redirect_uri_mismatch|invalid_client/i);
  }

  console.log(JSON.stringify({ ok: true, youtube: 'accepted', twitch: 'accepted', pkce: true }));
} finally {
  if (cookie) await jsonRequest('/api/auth/account', { method: 'DELETE', body: { confirmation: username } }).catch(() => {});
}
