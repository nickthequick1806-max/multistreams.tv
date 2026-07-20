import { HttpError, json, readJson } from '../lib/http.js';
import { nowIso, requireSession } from '../lib/db.js';
import { randomId } from '../lib/crypto.js';

const RARITIES = [
  { id: 'mythic', label: 'Mythic', chance: 0.0005, color: '#d946ef', image: '/COLLECTIBLE CARD IMAGES/Mythic_Card.png' },
  { id: 'legendary', label: 'Legendary', chance: 0.2995, color: '#ffb000', image: '/COLLECTIBLE CARD IMAGES/Legendary_Card.png' },
  { id: 'epic', label: 'Epic', chance: 4.7, color: '#ff3158', image: '/COLLECTIBLE CARD IMAGES/Epic_Card.png' },
  { id: 'rare', label: 'Rare', chance: 12, color: '#46b4f6', image: '/COLLECTIBLE CARD IMAGES/Rare_Card.png' },
  { id: 'uncommon', label: 'Uncommon', chance: 28, color: '#43ed21', image: '/COLLECTIBLE CARD IMAGES/Uncommon_Card.png' },
  { id: 'common', label: 'Common', chance: 55, color: '#aeb5bb', image: '/COLLECTIBLE CARD IMAGES/Common_Card.png' }
];

const CATALOG = RARITIES.flatMap(rarity => Array.from({ length: 10 }, (_, index) => ({
  id: `${rarity.id}-${index + 1}`, name: `${rarity.label} Collectible ${index + 1}`, rarity: rarity.id,
  rarityLabel: rarity.label, color: rarity.color, image: rarity.image, chance: rarity.chance
})));

function developerMode(env) {
  return String(env.REWARD_DEVELOPER_MODE || '').toLowerCase() === 'true';
}

function randomUnit() {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return bytes[0] / 0x1_0000_0000;
}

async function inventory(env, userId) {
  const rows = await env.DB.prepare('SELECT collectible_id, rarity, unlocked_at FROM collectibles WHERE user_id = ?1').bind(userId).all();
  const byId = new Map((rows.results || []).map(row => [row.collectible_id, row]));
  return CATALOG.map(card => ({ ...card, unlocked: byId.has(card.id), unlockedAt: byId.get(card.id)?.unlocked_at || null }));
}

async function rewardStatus(request, env) {
  const session = await requireSession(request, env);
  const row = await env.DB.prepare('SELECT * FROM daily_rewards WHERE user_id = ?1').bind(session.user_id).first();
  const watchSeconds = Number(row?.watch_seconds_today || 0);
  const nextClaimAt = row?.next_claim_at || null;
  const cooldownComplete = !nextClaimAt || new Date(nextClaimAt).getTime() <= Date.now();
  const devMode = developerMode(env);
  return json({ ok: true, status: { watchSeconds, requiredWatchSeconds: devMode ? 0 : 3600, ready: devMode || (watchSeconds >= 3600 && cooldownComplete), nextClaimAt: devMode ? null : nextClaimAt, lastClaimedAt: row?.last_claimed_at || null, developerMode: devMode } });
}

async function addWatchtime(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const seconds = Math.max(0, Math.min(60, Math.floor(Number(body.seconds) || 0)));
  if (!seconds) return rewardStatus(request, env);
  const timestamp = nowIso();
  const before = await env.DB.prepare('SELECT watch_seconds_today FROM daily_rewards WHERE user_id = ?1').bind(session.user_id).first();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET watch_seconds = watch_seconds + ?1, updated_at = ?2 WHERE id = ?3').bind(seconds, timestamp, session.user_id),
    env.DB.prepare(`INSERT INTO daily_rewards (user_id, watch_seconds_today, updated_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(user_id) DO UPDATE SET watch_seconds_today = watch_seconds_today + excluded.watch_seconds_today, updated_at = excluded.updated_at`)
      .bind(session.user_id, seconds, timestamp)
  ]);
  if (Number(before?.watch_seconds_today || 0) < 3600 && Number(before?.watch_seconds_today || 0) + seconds >= 3600) {
    await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, message, created_at) VALUES (?1, ?2, 'reward', 'Your daily reward is ready to claim.', ?3)`)
      .bind(randomId(), session.user_id, timestamp).run();
  }
  return rewardStatus(request, env);
}

async function claimReward(request, env) {
  const session = await requireSession(request, env);
  const row = await env.DB.prepare('SELECT * FROM daily_rewards WHERE user_id = ?1').bind(session.user_id).first();
  const devMode = developerMode(env);
  if (!devMode && Number(row?.watch_seconds_today || 0) < 3600) throw new HttpError(409, 'Watch 60 minutes before claiming today’s reward.', 'reward_not_ready');
  if (!devMode && row?.next_claim_at && new Date(row.next_claim_at).getTime() > Date.now()) throw new HttpError(409, 'Today’s reward has already been claimed.', 'reward_already_claimed');
  const cards = await inventory(env, session.user_id);
  const available = cards.filter(card => !card.unlocked);
  if (!available.length) throw new HttpError(409, 'Every collectible has already been unlocked.', 'collection_complete');
  const availableRarities = RARITIES.filter(rarity => available.some(card => card.rarity === rarity.id));
  const totalWeight = availableRarities.reduce((total, rarity) => total + rarity.chance, 0);
  let roll = randomUnit() * totalWeight;
  let rarity = availableRarities[availableRarities.length - 1];
  for (const candidate of availableRarities) {
    roll -= candidate.chance;
    if (roll < 0) { rarity = candidate; break; }
  }
  const pool = available.filter(card => card.rarity === rarity.id);
  const card = pool[Math.floor(randomUnit() * pool.length)];
  const timestamp = nowIso();
  const nextClaimAt = devMode ? null : new Date(Date.now() + 24 * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO collectibles (user_id, collectible_id, rarity, unlocked_at) VALUES (?1, ?2, ?3, ?4)').bind(session.user_id, card.id, card.rarity, timestamp),
    env.DB.prepare('UPDATE daily_rewards SET last_claimed_at = ?1, next_claim_at = ?2, watch_seconds_today = 0, updated_at = ?1 WHERE user_id = ?3').bind(timestamp, nextClaimAt, session.user_id)
  ]);
  return json({ ok: true, reward: { ...card, unlocked: true, unlockedAt: timestamp }, nextClaimAt });
}

async function listNotifications(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare('SELECT * FROM notifications WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100').bind(session.user_id).all();
  return json({ ok: true, notifications: (rows.results || []).map(row => ({ id: row.id, type: row.type, message: row.message, metadata: JSON.parse(row.metadata_json || '{}'), readAt: row.read_at, createdAt: row.created_at })) });
}

async function readNotifications(request, env) {
  const session = await requireSession(request, env);
  await env.DB.prepare('UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL').bind(nowIso(), session.user_id).run();
  return json({ ok: true });
}

export async function handleRewardRoute(request, env, url) {
  if (url.pathname === '/api/rewards/status' && request.method === 'GET') return rewardStatus(request, env);
  if (url.pathname === '/api/rewards/claim' && request.method === 'POST') return claimReward(request, env);
  if (url.pathname === '/api/collectibles' && request.method === 'GET') {
    const session = await requireSession(request, env);
    return json({ ok: true, cards: await inventory(env, session.user_id), rarities: RARITIES });
  }
  if (url.pathname === '/api/watchtime' && request.method === 'POST') return addWatchtime(request, env);
  if (url.pathname === '/api/notifications' && request.method === 'GET') return listNotifications(request, env);
  if (url.pathname === '/api/notifications/read' && request.method === 'POST') return readNotifications(request, env);
  return null;
}

export { CATALOG, RARITIES };
