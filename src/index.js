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

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const legacyPage = url.pathname.match(/^\/([a-z0-9-]+)\.html$/i)?.[1]?.toLowerCase();
    if (legacyPage && ['GET', 'HEAD'].includes(request.method) && (legacyPage === 'index' || CLEAN_PAGE_NAMES.has(legacyPage))) {
      url.pathname = legacyPage === 'index' ? '/' : `/${legacyPage}`;
      return Response.redirect(url.toString(), 308);
    }
    if (/^\/profile\/[^/]+\/?$/.test(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
      const shellUrl = new URL('/multistreams.html', url.origin);
      const shellRequest = new Request(shellUrl, { method: request.method, headers: request.headers });
      const shell = await env.ASSETS.fetch(shellRequest);
      return securityHeaders(new Response(shell.body, {
        status: shell.ok ? 200 : shell.status,
        headers: shell.headers
      }));
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
