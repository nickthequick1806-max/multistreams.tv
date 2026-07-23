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
let detail = null;
for (const query of ['live news', '24/7 live', 'music live', 'gaming live']) {
  const directory = await api(`/api/browse/youtube?view=live&q=${encodeURIComponent(query)}&limit=8`);
  for (const candidate of (directory.items || []).filter(item => item.live && /^[A-Za-z0-9_-]{11}$/.test(item.id))) {
    const candidateDetail = (await api(`/api/channel/youtube/${encodeURIComponent(candidate.id)}`)).channel;
    if (candidateDetail.requestedVideo?.live === true && candidateDetail.live === true) {
      live = candidate;
      detail = candidateDetail;
      break;
    }
  }
  if (live && detail) break;
}
assert.ok(live, 'YouTube live directory did not return a playable live video.');

assert.equal(detail.requestedVideo?.id, live.id);
assert.equal(detail.requestedVideo?.live, true);
assert.equal(detail.live, true);

const offline = (await api('/api/channel/youtube/dQw4w9WgXcQ')).channel;
assert.equal(offline.requestedVideo?.live, false);
assert.equal(offline.live, false);

const player = await fetch(`https://www.youtube.com/embed/${encodeURIComponent(live.id)}?autoplay=1&mute=1`, { redirect: 'manual' });
assert.equal(player.status, 200);
const chat = await fetch(`https://www.youtube.com/live_chat?v=${encodeURIComponent(live.id)}&embed_domain=multistreams.tv`, { redirect: 'manual' });
assert.ok([200, 302].includes(chat.status));

console.log(JSON.stringify({ ok: true, videoId: live.id, channel: detail.name, player: player.status, chat: chat.status }));
