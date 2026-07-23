import { apiError, assertSameOrigin, HttpError, json } from './lib/http.js';
import { randomId } from './lib/crypto.js';
import { handleAuthRoute } from './routes/auth.js';
import { handleOAuthRoute } from './routes/oauth.js';
import { handlePlatformRoute } from './routes/platform.js';
import { handleDataRoute } from './routes/data.js';
import { handleProfileRoute } from './routes/profile.js';
import { handleRewardRoute } from './routes/rewards.js';
import { handleAiRoute } from './routes/ai.js';
import { handleMediaRoute } from './routes/media.js';
import { handleThirdPartyRoute } from './routes/third-party.js';

const routeHandlers = [handleAuthRoute, handleOAuthRoute, handlePlatformRoute, handleDataRoute, handleProfileRoute, handleRewardRoute, handleAiRoute, handleMediaRoute, handleThirdPartyRoute];
const CLEAN_PAGE_NAMES = new Set(['home', 'multistreams', 'about', 'contact', 'blog', 'status', 'twitch', 'kick', 'youtube', 'rumble', 'guidelines', 'terms', 'privacy', 'dmca']);

function securityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('x-frame-options', 'SAMEORIGIN');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('cross-origin-opener-policy', 'same-origin-allow-popups');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

class ReplaceAttribute {
  constructor(name, value) {
    this.name = name;
    this.value = value;
  }
  element(element) {
    element.setAttribute(this.name, this.value);
  }
}

class ReplaceText {
  constructor(value) {
    this.value = value;
  }
  element(element) {
    element.setInnerContent(this.value);
  }
}

async function profileShell(request, env, url) {
  const username = decodeURIComponent(url.pathname.match(/^\/profile\/([^/]+)\/?$/)?.[1] || '');
  const profile = await env.DB.prepare(`SELECT username, banner_url, bio, profile_visibility FROM users
    WHERE username = ?1 COLLATE NOCASE`).bind(username).first();
  const visible = profile?.profile_visibility !== 'hidden';
  const displayName = profile?.username || username;
  const defaultDescription = 'Watch Twitch, Kick, YouTube and Rumble streams side by side in a clean multiview layout.';
  const description = visible && String(profile?.bio || '').trim() ? String(profile.bio).trim().slice(0, 300) : defaultDescription;
  const bannerValue = visible && profile?.banner_url ? profile.banner_url : 'https://i.postimg.cc/zXqp6fVh/og-image.png';
  const banner = new URL(bannerValue, url.origin).toString();
  const title = `${displayName} | Multistreams.tv`;
  const profileUrl = `${url.origin}/profile/${encodeURIComponent(displayName)}`;
  const shellUrl = new URL('/multistreams.html', url.origin);
  const shell = await env.ASSETS.fetch(new Request(shellUrl, { method: request.method, headers: request.headers }));
  const rewritten = new HTMLRewriter()
    .on('title', new ReplaceText(title))
    .on('meta[name="description"]', new ReplaceAttribute('content', description))
    .on('link[rel="canonical"]', new ReplaceAttribute('href', profileUrl))
    .on('meta[property="og:url"]', new ReplaceAttribute('content', profileUrl))
    .on('meta[property="og:title"]', new ReplaceAttribute('content', title))
    .on('meta[property="og:description"]', new ReplaceAttribute('content', description))
    .on('meta[property="og:image"]', new ReplaceAttribute('content', banner))
    .on('meta[property="og:image:alt"]', new ReplaceAttribute('content', `${displayName}'s Multistreams.tv profile banner`))
    .on('meta[name="twitter:title"]', new ReplaceAttribute('content', title))
    .on('meta[name="twitter:description"]', new ReplaceAttribute('content', description))
    .on('meta[name="twitter:image"]', new ReplaceAttribute('content', banner))
    .transform(shell);
  return securityHeaders(new Response(rewritten.body, { status: shell.ok ? 200 : shell.status, headers: rewritten.headers }));
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const legacyPage = url.pathname.match(/^\/([a-z0-9-]+)\.html$/i)?.[1]?.toLowerCase();
    if (legacyPage && ['GET', 'HEAD'].includes(request.method) && (legacyPage === 'index' || CLEAN_PAGE_NAMES.has(legacyPage))) {
      url.pathname = legacyPage === 'index' ? '/' : `/${legacyPage}`;
      return Response.redirect(url.toString(), 308);
    }
    if (/^\/profile\/[^/]+\/?$/.test(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
      return profileShell(request, env, url);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const requestId = request.headers.get('cf-ray') || randomId(10);
    try {
      assertSameOrigin(request, env);
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const db = await env.DB.prepare('SELECT 1 AS healthy').first();
        return securityHeaders(json({ ok: true, service: 'multistreams-api', database: db?.healthy === 1, timestamp: new Date().toISOString(), requestId }));
      }
      for (const handler of routeHandlers) {
        const response = await handler(request, env, url, context);
        if (response) return securityHeaders(response);
      }
      throw new HttpError(404, 'API route not found.', 'route_not_found');
    } catch (error) {
      return securityHeaders(apiError(error, requestId));
    }
  }
};
