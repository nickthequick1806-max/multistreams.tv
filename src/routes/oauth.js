import { HttpError, json, readJson, safeRedirectPath, sessionCookie } from '../lib/http.js';
import { createSession, nowIso, optionalSession, requireSession } from '../lib/db.js';
import { decrypt, encrypt, randomId, sha256 } from '../lib/crypto.js';
import { syncYoutubeSubscriptionsForUser } from '../platforms.js';

const OAUTH = {
  twitch: {
    authorize: 'https://id.twitch.tv/oauth2/authorize',
    token: 'https://id.twitch.tv/oauth2/token',
    scopes: ['user:read:email', 'user:read:follows']
  },
  youtube: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/youtube.readonly']
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile']
  },
  kick: {
    authorize: 'https://id.kick.com/oauth/authorize',
    token: 'https://id.kick.com/oauth/token',
    scopes: ['user:read', 'channel:read']
  }
};

const GOOGLE_YOUTUBE_PURPOSE = 'youtube-connect';

function connectionPlatform(platform, purpose) {
  return platform === 'google' && purpose === GOOGLE_YOUTUBE_PURPOSE ? 'youtube' : platform;
}

function requestedScopes(platform, purpose) {
  if (platform === 'google') return OAUTH.youtube.scopes;
  return connectionPlatform(platform, purpose) === 'youtube' ? OAUTH.youtube.scopes : OAUTH[platform].scopes;
}

function clientCredentials(env, platform) {
  if (platform === 'twitch') return { id: env.TWITCH_CLIENT_ID, secret: env.TWITCH_CLIENT_SECRET };
  if (platform === 'kick') return { id: env.KICK_CLIENT_ID, secret: env.KICK_CLIENT_SECRET };
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}

function callbackUrl(env, platform) {
  return `${new URL(env.APP_ORIGIN).origin}/api/oauth/${platform}/callback`;
}

function providerRedirectUrl(env, platform) {
  if (platform === 'twitch') {
    return String(env.TWITCH_REDIRECT_URI || `${new URL(env.APP_ORIGIN).origin}/multistreams`);
  }
  return callbackUrl(env, platform);
}

async function startOAuth(request, env, platform, url) {
  const config = OAUTH[platform];
  if (!config) throw new HttpError(404, 'This platform does not provide a supported OAuth connection.', 'oauth_unsupported');
  const purpose = platform === 'google' ? String(url.searchParams.get('purpose') || 'login') : 'connect';
  if (platform === 'google' && !['login', GOOGLE_YOUTUBE_PURPOSE].includes(purpose)) {
    throw new HttpError(400, 'This Google account flow is not supported.', 'oauth_purpose_invalid');
  }
  const session = await optionalSession(request, env);
  if (purpose !== 'login' && !session) throw new HttpError(401, 'Sign in before connecting a platform.', 'authentication_required');
  const credentials = clientCredentials(env, platform);
  if (!credentials.id || !credentials.secret) throw new HttpError(503, `${platform} OAuth is not configured.`, 'oauth_not_configured');
  const state = randomId(24);
  const verifier = randomId(48);
  const redirectUri = providerRedirectUrl(env, platform);
  const redirectTo = safeRedirectPath(url.searchParams.get('returnTo'));
  const timestamp = nowIso();
  await env.DB.prepare(`INSERT INTO auth_challenges (id, user_id, type, verifier, redirect_to, metadata_json, created_at, expires_at)
    VALUES (?1, ?2, 'oauth', ?3, ?4, ?5, ?6, ?7)`)
    .bind(state, session?.user_id || null, verifier, redirectTo, JSON.stringify({ platform, purpose, redirectUri }), timestamp, new Date(Date.now() + 10 * 60_000).toISOString()).run();
  const params = new URLSearchParams({
    client_id: credentials.id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: requestedScopes(platform, purpose).join(' '),
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256'
  });
  if (platform === 'youtube' || platform === 'google') {
    params.set('access_type', 'offline');
    params.set('include_granted_scopes', 'true');
    params.set('prompt', 'consent');
  }
  if (platform === 'twitch') params.set('force_verify', 'true');
  return Response.redirect(`${config.authorize}?${params.toString()}`, 302);
}

async function exchangeCode(env, platform, code, verifier, redirectUri) {
  const config = OAUTH[platform];
  const credentials = clientCredentials(env, platform);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: credentials.id,
    client_secret: credentials.secret,
    redirect_uri: redirectUri || providerRedirectUrl(env, platform),
    code_verifier: verifier
  });
  const response = await fetch(config.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    console.error(JSON.stringify({ level: 'error', event: 'oauth_exchange_failed', platform, status: response.status, providerError: payload.error || '' }));
    throw new HttpError(502, `${platform} rejected the OAuth token exchange.`, 'oauth_exchange_failed');
  }
  return payload;
}

async function fetchIdentity(platform, accessToken, env) {
  if (platform === 'twitch') {
    const response = await fetch('https://api.twitch.tv/helix/users', { headers: { authorization: `Bearer ${accessToken}`, 'client-id': env.TWITCH_CLIENT_ID } });
    const payload = await response.json();
    const user = payload.data?.[0];
    if (!user) throw new HttpError(502, 'Twitch did not return the connected user.', 'identity_unavailable');
    return { id: user.id, username: user.login, email: user.email || '', avatarUrl: user.profile_image_url || '', bannerUrl: user.offline_image_url || '', raw: user };
  }
  if (platform === 'youtube') {
    const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${accessToken}` } });
    const payload = await response.json();
    const channel = payload.items?.[0];
    if (!channel) throw new HttpError(502, 'YouTube did not return a channel for this account.', 'identity_unavailable');
    return { id: channel.id, username: channel.snippet?.customUrl || channel.snippet?.title || channel.id, avatarUrl: channel.snippet?.thumbnails?.high?.url || '', raw: channel };
  }
  if (platform === 'google') {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
    const profile = await response.json();
    if (!response.ok || !profile.sub || !profile.email) throw new HttpError(502, 'Google did not return a verified account profile.', 'identity_unavailable');
    return { id: profile.sub, username: profile.name || profile.email.split('@')[0], email: profile.email, avatarUrl: profile.picture || '', raw: profile };
  }
  if (platform === 'kick') {
    const response = await fetch('https://api.kick.com/public/v1/users', { headers: { authorization: `Bearer ${accessToken}` } });
    const payload = await response.json();
    const user = payload.data?.[0] || payload.data || payload;
    if (!response.ok || !user?.user_id && !user?.id) throw new HttpError(502, 'Kick did not return the connected user.', 'identity_unavailable');
    return { id: String(user.user_id || user.id), username: user.name || user.username || String(user.user_id || user.id), avatarUrl: user.profile_picture || user.profile_pic || '', raw: user };
  }
  throw new HttpError(400, 'Unsupported OAuth platform.', 'oauth_unsupported');
}

async function uniqueUsername(env, preferred) {
  const base = String(preferred || 'user').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24) || 'user';
  for (let index = 0; index < 100; index += 1) {
    const candidate = index ? `${base}${index}` : base;
    const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?1').bind(candidate).first();
    if (!exists) return candidate;
  }
  return `user-${randomId(5)}`;
}

async function finishGoogleLogin(request, env, identity) {
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(identity.email.toLowerCase()).first();
  const timestamp = nowIso();
  if (!user) {
    const id = randomId();
    const username = await uniqueUsername(env, identity.username);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, username, auth_method, avatar_url, created_at, updated_at)
        VALUES (?1, ?2, ?3, 'google', ?4, ?5, ?5)`).bind(id, identity.email.toLowerCase(), username, identity.avatarUrl, timestamp),
      env.DB.prepare('INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?1, ?2, ?3)').bind(id, '{}', timestamp),
      env.DB.prepare('INSERT INTO user_state (user_id, channels_json, layout, updated_at) VALUES (?1, ?2, ?3, ?4)').bind(id, '[]', 'grid', timestamp),
      env.DB.prepare('INSERT INTO daily_rewards (user_id, updated_at) VALUES (?1, ?2)').bind(id, timestamp)
    ]);
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  }
  if (user.two_factor_enabled && user.two_factor_secret) {
    const ticket = randomId(24);
    await env.DB.prepare(`INSERT INTO auth_challenges (id, user_id, type, created_at, expires_at)
      VALUES (?1, ?2, 'login_totp', ?3, ?4)`).bind(ticket, user.id, timestamp, new Date(Date.now() + 5 * 60_000).toISOString()).run();
    return { user, requiresTwoFactor: true, ticket };
  }
  return { user, token: await createSession(request, env, user.id), requiresTwoFactor: false };
}

export async function saveConnection(env, userId, platform, identity, tokens, scopes) {
  const timestamp = nowIso();
  const expiresAt = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null;
  const grantedScopes = Array.isArray(tokens.scope)
    ? tokens.scope.join(' ')
    : String(tokens.scope || scopes.join(' '));
  await env.DB.prepare(`INSERT INTO oauth_connections
    (id, user_id, platform, platform_user_id, platform_username, access_token, refresh_token, token_type, scopes, expires_at, metadata_json, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
    ON CONFLICT(user_id, platform) DO UPDATE SET platform_user_id = excluded.platform_user_id, platform_username = excluded.platform_username,
      access_token = excluded.access_token,
      refresh_token = CASE WHEN excluded.refresh_token != '' THEN excluded.refresh_token ELSE oauth_connections.refresh_token END,
      token_type = excluded.token_type, scopes = excluded.scopes,
      expires_at = excluded.expires_at, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .bind(randomId(), userId, platform, identity.id, identity.username, await encrypt(tokens.access_token, env.TOKEN_ENCRYPTION_KEY),
      tokens.refresh_token ? await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY) : '', tokens.token_type || 'Bearer', grantedScopes,
      expiresAt, JSON.stringify({ avatarUrl: identity.avatarUrl || '', bannerUrl: identity.bannerUrl || '' }), timestamp).run();
}

async function finishOAuth(request, env, platform, url, context) {
  const error = url.searchParams.get('error');
  const state = String(url.searchParams.get('state') || '');
  const code = String(url.searchParams.get('code') || '');
  const challenge = await env.DB.prepare(`SELECT * FROM auth_challenges WHERE id = ?1 AND type = 'oauth' AND expires_at > ?2`).bind(state, nowIso()).first();
  if (!challenge) throw new HttpError(400, 'The OAuth request expired or could not be verified.', 'oauth_state_invalid');
  const metadata = JSON.parse(challenge.metadata_json || '{}');
  if (metadata.platform !== platform) throw new HttpError(400, 'The OAuth provider did not match the original request.', 'oauth_state_invalid');
  const connectedPlatform = connectionPlatform(platform, metadata.purpose);
  await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(state).run();
  const destination = new URL(challenge.redirect_to || '/multistreams', env.APP_ORIGIN);
  if (error || !code) {
    destination.searchParams.set('oauth', connectedPlatform);
    destination.searchParams.set('status', 'cancelled');
    return Response.redirect(destination.toString(), 302);
  }
  const tokens = await exchangeCode(env, platform, code, challenge.verifier, metadata.redirectUri);
  const identity = await fetchIdentity(connectedPlatform, tokens.access_token, env);
  if (platform === 'google' && metadata.purpose === 'login') {
    const result = await finishGoogleLogin(request, env, identity);
    let youtubeIdentity = null;
    try { youtubeIdentity = await fetchIdentity('youtube', tokens.access_token, env); }
    catch (youtubeError) { console.warn(JSON.stringify({ event: 'google_login_youtube_connection_unavailable', message: youtubeError.message || '' })); }
    if (result.requiresTwoFactor) {
      if (youtubeIdentity) {
        const pendingConnection = await encrypt(JSON.stringify({ platform: 'youtube', identity: youtubeIdentity, tokens, scopes: OAUTH.youtube.scopes }), env.TOKEN_ENCRYPTION_KEY);
        await env.DB.prepare(`UPDATE auth_challenges SET secret = ?1, metadata_json = ?2 WHERE id = ?3 AND type = 'login_totp'`)
          .bind(pendingConnection, JSON.stringify({ provider: 'google', pendingConnection: true }), result.ticket).run();
      }
      destination.searchParams.set('auth', 'two-factor');
      destination.searchParams.set('ticket', result.ticket);
      return Response.redirect(destination.toString(), 302);
    }
    if (youtubeIdentity) {
      await saveConnection(env, result.user.id, 'youtube', youtubeIdentity, tokens, OAUTH.youtube.scopes);
      const syncJob = syncYoutubeSubscriptionsForUser(env, result.user.id).catch(error => console.warn(JSON.stringify({ event: 'youtube_subscription_sync_failed', message: error.message || '' })));
      if (context?.waitUntil) context.waitUntil(syncJob); else await syncJob;
      destination.searchParams.set('oauth', 'youtube');
      destination.searchParams.set('status', 'connected');
    }
    destination.searchParams.set('auth', 'success');
    return new Response(null, { status: 302, headers: { location: destination.toString(), 'set-cookie': sessionCookie(env, result.token) } });
  }
  if (!challenge.user_id) throw new HttpError(401, 'Sign in before connecting a platform.', 'authentication_required');
  await saveConnection(env, challenge.user_id, connectedPlatform, identity, tokens, requestedScopes(platform, metadata.purpose));
  if (connectedPlatform === 'youtube') {
    const syncJob = syncYoutubeSubscriptionsForUser(env, challenge.user_id).catch(error => console.warn(JSON.stringify({ event: 'youtube_subscription_sync_failed', message: error.message || '' })));
    if (context?.waitUntil) context.waitUntil(syncJob); else await syncJob;
  }
  destination.searchParams.set('oauth', connectedPlatform);
  destination.searchParams.set('status', 'connected');
  return Response.redirect(destination.toString(), 302);
}

async function connectRumble(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const timestamp = nowIso();
  if (body.popupConfirmed === true) {
    await env.DB.prepare(`INSERT INTO oauth_connections
      (id, user_id, platform, platform_user_id, platform_username, access_token, metadata_json, created_at, updated_at)
      VALUES (?1, ?2, 'rumble', '', 'Rumble account', ?3, ?4, ?5, ?5)
      ON CONFLICT(user_id, platform) DO UPDATE SET platform_user_id = excluded.platform_user_id, platform_username = excluded.platform_username,
        access_token = excluded.access_token, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
      .bind(randomId(), session.user_id, await encrypt('', env.TOKEN_ENCRYPTION_KEY), JSON.stringify({ connectionType: 'account-popup', dataAccess: false }), timestamp).run();
    return json({ ok: true, platform: 'rumble', username: 'Rumble account', dataAccess: false });
  }
  let apiUrl;
  try { apiUrl = new URL(String(body.apiUrl || '')); } catch { throw new HttpError(400, 'Enter your Rumble Live Stream API URL.', 'invalid_rumble_url'); }
  if (apiUrl.protocol !== 'https:' || apiUrl.hostname !== 'rumble.com') throw new HttpError(400, 'Only a rumble.com Live Stream API URL is accepted.', 'invalid_rumble_url');
  const response = await fetch(apiUrl.toString(), { headers: { accept: 'application/json' } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !Array.isArray(payload.livestreams)) throw new HttpError(400, 'Rumble did not recognize that Live Stream API URL.', 'invalid_rumble_url');
  await env.DB.prepare(`INSERT INTO oauth_connections
    (id, user_id, platform, platform_user_id, platform_username, access_token, metadata_json, created_at, updated_at)
    VALUES (?1, ?2, 'rumble', ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(user_id, platform) DO UPDATE SET platform_user_id = excluded.platform_user_id, platform_username = excluded.platform_username,
      access_token = excluded.access_token, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .bind(randomId(), session.user_id, String(payload.user_id || payload.channel_id || ''), String(payload.username || payload.user_id || 'Rumble creator'),
      await encrypt(apiUrl.toString(), env.TOKEN_ENCRYPTION_KEY), JSON.stringify({ connectionType: 'live-stream-api' }), timestamp).run();
  return json({ ok: true, platform: 'rumble', username: payload.username || payload.user_id || 'Rumble creator' });
}

async function listConnections(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare('SELECT platform, platform_user_id, platform_username, metadata_json, updated_at FROM oauth_connections WHERE user_id = ?1 ORDER BY platform')
    .bind(session.user_id).all();
  return json({ ok: true, connections: (rows.results || []).map(row => ({ platform: row.platform, userId: row.platform_user_id, username: row.platform_username, metadata: JSON.parse(row.metadata_json || '{}'), updatedAt: row.updated_at })) });
}

async function disconnect(request, env, platform) {
  const session = await requireSession(request, env);
  await env.DB.prepare('DELETE FROM oauth_connections WHERE user_id = ?1 AND platform = ?2').bind(session.user_id, platform).run();
  return json({ ok: true, platform });
}

export async function handleOAuthRoute(request, env, url, context) {
  if (url.pathname === '/api/platform/connections' && request.method === 'GET') return listConnections(request, env);
  if (url.pathname === '/api/platform/rumble/connect' && request.method === 'POST') return connectRumble(request, env);
  const match = url.pathname.match(/^\/api\/oauth\/([a-z]+)\/(start|callback)$/);
  if (match) {
    const [, platform, action] = match;
    if (action === 'start' && request.method === 'GET') return startOAuth(request, env, platform, url);
    if (action === 'callback' && request.method === 'GET') return finishOAuth(request, env, platform, url, context);
  }
  const disconnectMatch = url.pathname.match(/^\/api\/platform\/([a-z]+)$/);
  if (disconnectMatch && request.method === 'DELETE') return disconnect(request, env, disconnectMatch[1]);
  return null;
}
