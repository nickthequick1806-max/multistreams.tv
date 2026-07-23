import assert from 'node:assert/strict';

const base = process.env.MULTISTREAMS_TEST_URL || 'https://multistreams.tv';

async function api(path) {
  const response = await fetch(`${base}${path}`, { headers: { origin: 'https://multistreams.tv' } });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(payload)}`);
  return payload;
}

const browse = await api('/api/browse/kick?view=live&limit=40');
assert.ok(browse.items.length > 0, 'Kick Browse returned no live channels.');
assert.ok(browse.items.every(item => item.live === true), 'Kick Browse returned an item that was not live.');
assert.ok(browse.items.every(item => item.avatar || !item.broadcasterUserId), 'Kick Browse omitted an available broadcaster PFP.');
assert.ok(browse.items.every(item => item.viewerCountAvailable ? Number(item.viewers) > 0 : item.viewers === null), 'Kick viewer-count availability was inconsistent.');

const positive = browse.items.find(item => item.avatar && item.viewerCountAvailable);
const hidden = browse.items.find(item => item.live && !item.viewerCountAvailable);
assert.ok(positive, 'Kick Browse did not provide a live channel with a visible viewer count and PFP.');
assert.ok(hidden, 'Kick Browse did not provide a live/hidden-viewer fallback case.');

const liveDetail = (await api(`/api/channel/kick/${encodeURIComponent(positive.username)}`)).channel;
assert.equal(liveDetail.live, true);
assert.ok(liveDetail.avatar);
assert.equal(liveDetail.viewerCountAvailable, Number(liveDetail.viewers) > 0);

const offline = (await api('/api/channel/kick/xqc')).channel;
assert.equal(offline.live, false);
assert.equal(offline.viewerCountAvailable, false);
assert.equal(offline.viewers, null);
assert.ok(offline.avatar, 'Kick offline channel did not return its official PFP.');

const search = await api('/api/search/global?q=xqc&limit=20');
const kickResult = search.items.find(item => item.platform === 'kick' && item.username.toLowerCase() === 'xqc');
assert.ok(kickResult);
assert.ok(kickResult.avatar, 'Kick search did not reuse the official PFP.');

console.log(JSON.stringify({
  ok: true,
  browseCount: browse.items.length,
  live: { username: positive.username, viewers: positive.viewers },
  hiddenViewer: hidden.username,
  offline: offline.username,
  search: kickResult.username
}));
