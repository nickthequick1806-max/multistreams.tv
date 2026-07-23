import assert from 'node:assert/strict';

const base = process.env.MULTISTREAMS_TEST_URL || 'https://multistreams.tv';
const headers = { origin: 'https://multistreams.tv' };

async function api(path) {
  const response = await fetch(`${base}${path}`, { headers });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(payload)}`);
  return payload;
}

let live = null;
for (const query of ['live news', '24/7 live', 'music live', 'gaming live']) {
  const directory = await api(`/api/browse/youtube?view=live&q=${encodeURIComponent(query)}&limit=8`);
  live = (directory.items || []).find(item => item.live && /^[A-Za-z0-9_-]{11}$/.test(item.id));
  if (live) break;
}
assert.ok(live, 'YouTube live directory did not return a playable live video.');

const detail = (await api(`/api/channel/youtube/${encodeURIComponent(live.id)}`)).channel;
assert.equal(detail.requestedVideo?.id, live.id);
assert.equal(detail.requestedVideo?.live, true);
assert.equal(detail.live, true);

const player = await fetch(`https://www.youtube.com/embed/${encodeURIComponent(live.id)}?autoplay=1&mute=1`, { redirect: 'manual' });
assert.equal(player.status, 200);
const chat = await fetch(`https://www.youtube.com/live_chat?v=${encodeURIComponent(live.id)}&embed_domain=multistreams.tv`, { redirect: 'manual' });
assert.ok([200, 302].includes(chat.status));

console.log(JSON.stringify({ ok: true, videoId: live.id, channel: detail.name, player: player.status, chat: chat.status }));
