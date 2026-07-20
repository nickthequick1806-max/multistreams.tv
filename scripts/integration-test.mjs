import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { totpCode } from '../src/lib/crypto.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const base = process.env.MULTISTREAMS_TEST_URL || 'http://127.0.0.1:8787';
const origin = 'https://multistreams.tv';
const skipExternalNotifications = process.env.MULTISTREAMS_SKIP_EXTERNAL_NOTIFICATIONS === 'true';
const skipRewards = process.env.MULTISTREAMS_SKIP_REWARDS === 'true';
let cookie = '';

async function request(path, { method = 'GET', body, expected = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function upload(path, form, expected = 200) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { origin, cookie }, body: form });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `POST ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const username = `integration${String(suffix).replace(/\D/g, '').slice(-12)}`;
const email = `${username}@example.test`;
const password = 'Integration-password-42!';

const health = await request('/api/health');
assert.equal(health.database, true);

const signup = await request('/api/auth/signup', { method: 'POST', expected: 201, body: { email, username, password } });
assert.equal(signup.user.username, username);
assert.match(cookie, /^ms_session=/);

if (!skipExternalNotifications) {
  const contact = await request('/api/contact', { method: 'POST', expected: 201, body: { name: 'Integration QA', email, subject: 'Backend test', message: 'Confirm the contact form is stored by the backend.' } });
  assert.ok(contact.id);
}

await request('/api/profile/me', { method: 'PATCH', body: { bio: 'Backend integration profile', profileVisibility: 'public', socials: { twitch: 'https://twitch.tv/twitchdev' } } });
const profile = await request('/api/profile/me');
assert.equal(profile.profile.bio, 'Backend integration profile');
assert.equal(profile.profile.socials.twitch, 'https://twitch.tv/twitchdev');

const avatarForm = new FormData();
avatarForm.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'avatar.png');
const uploadedAvatar = await upload('/api/uploads/profile?type=avatar', avatarForm);
assert.match(uploadedAvatar.url, /\/api\/media\/profiles\//);
const avatarPath = new URL(uploadedAvatar.url).pathname;
const avatarResponse = await fetch(`${base}${avatarPath}`);
assert.equal(avatarResponse.status, 200);
assert.equal(avatarResponse.headers.get('content-type'), 'image/png');
assert.ok((await avatarResponse.arrayBuffer()).byteLength > 0);

await request('/api/settings', { method: 'PUT', body: { settings: { theme: 'dark', language: 'en' } } });
assert.deepEqual((await request('/api/settings')).settings, { theme: 'dark', language: 'en' });

const layoutChannels = [{ platform: 'twitch', name: 'twitchdev', displayName: 'TwitchDev', muted: true }];
await request('/api/state', { method: 'PUT', body: { channels: layoutChannels, layout: 'vertical' } });
assert.equal((await request('/api/state')).state.layout, 'vertical');
const saved = await request('/api/layouts', { method: 'POST', expected: 201, body: { name: 'Integration Layout', channels: layoutChannels, layout: 'vertical' } });
assert.equal((await request('/api/layouts')).layouts[0].id, saved.layout.id);

await request('/api/community-layouts', { method: 'POST', expected: 201, body: { name: 'Integration Community Layout', channels: layoutChannels, layout: 'vertical' } });
const community = await request(`/api/community-layouts?q=${encodeURIComponent(username)}`);
assert.equal(community.layouts[0].submittedBy, username);
assert.equal(community.layouts[0].submitterAvatar, uploadedAvatar.url);

const setup = await request('/api/security/totp/setup', { method: 'POST', body: {} });
assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);
await request('/api/security/totp/verify', { method: 'POST', body: { challengeId: setup.challengeId, code: await totpCode(setup.secret) } });

await request('/api/auth/logout', { method: 'POST', body: {} });
cookie = '';
const login = await request('/api/auth/login', { method: 'POST', body: { email, password } });
assert.equal(login.requiresTwoFactor, true);
const verified = await request('/api/auth/login/totp', { method: 'POST', body: { ticket: login.ticket, code: await totpCode(setup.secret) } });
assert.equal(verified.user.username, username);

let rewards = [];
if (!skipRewards) {
  const status = await request('/api/rewards/status');
  assert.equal(status.status.ready, true);
  assert.equal(status.status.developerMode, true);
  const reward = await request('/api/rewards/claim', { method: 'POST', body: {} });
  assert.match(reward.reward.id, /^(mythic|legendary|epic|rare|uncommon|common)-\d+$/);
  const collection = await request('/api/collectibles');
  assert.equal(collection.cards.length, 60);
  assert.equal(collection.cards.filter(card => card.unlocked).length, 1);
  const secondReward = await request('/api/rewards/claim', { method: 'POST', body: {} });
  assert.notEqual(secondReward.reward.id, reward.reward.id);
  assert.equal((await request('/api/collectibles')).cards.filter(card => card.unlocked).length, 2);
  rewards = [reward.reward.id, secondReward.reward.id];
}

const capabilities = await request('/api/platform/capabilities');
assert.equal(capabilities.capabilities.twitch.follows, true);
assert.equal(capabilities.capabilities.kick.clips, false);
assert.equal(capabilities.capabilities.rumble.oauth, false);

const search = await request(`/api/profiles?q=${encodeURIComponent(username.slice(0, 8))}`);
assert.equal(search.profiles.some(item => item.username === username), true);

await request(`/api/layouts/${saved.layout.id}`, { method: 'DELETE' });
assert.equal((await request('/api/layouts')).layouts.some(item => item.id === saved.layout.id), false);

await request('/api/auth/account', { method: 'DELETE', body: { confirmation: username } });
cookie = '';
assert.equal((await request('/api/auth/session')).authenticated, false);

console.log(JSON.stringify({ ok: true, checks: 36 - Number(skipExternalNotifications) - (skipRewards ? 7 : 0), user: username, rewards }));
