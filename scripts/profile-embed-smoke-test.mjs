import assert from 'node:assert/strict';

const base = process.env.MULTISTREAMS_TEST_URL || 'https://multistreams.tv';
const origin = 'https://multistreams.tv';
const suffix = String(Date.now()).slice(-10);
const username = `embedtest${suffix}`;
const email = `${username}@example.test`;
const password = 'Embed-test-password-42!';
const bio = 'A profile-specific biography for social sharing.';
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

try {
  await jsonRequest('/api/auth/signup', { method: 'POST', expected: 201, body: { email, username, password } });
  await jsonRequest('/api/profile/me', { method: 'PATCH', body: { bio } });
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'banner.png');
  const uploadResponse = await fetch(`${base}/api/uploads/profile?type=banner`, { method: 'POST', headers: { origin, cookie }, body: form });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);

  const shellResponse = await fetch(`${base}/profile/${encodeURIComponent(username)}`);
  const shell = await shellResponse.text();
  assert.equal(shellResponse.status, 200);
  assert.match(shell, new RegExp(`<title>${username} \\| Multistreams\\.tv<\\/title>`, 'i'));
  assert.match(shell, new RegExp(`property="og:description" content="${bio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i'));
  assert.match(shell, new RegExp(`property="og:image" content="${upload.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i'));
  console.log(JSON.stringify({ ok: true, title: username, bio: true, banner: true }));
} finally {
  if (cookie) await jsonRequest('/api/auth/account', { method: 'DELETE', body: { confirmation: username } }).catch(() => {});
}
