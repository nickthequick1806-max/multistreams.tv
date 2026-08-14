import { json } from '../lib/http.js';

const UPTIMEROBOT_ENDPOINT = 'https://api.uptimerobot.com/v2/getMonitors';
const UPTIMEROBOT_CACHE_SECONDS = 120;

function monitorStatus(value) {
  if (Number(value) === 2) return 'operational';
  if ([8, 9].includes(Number(value))) return 'down';
  return 'degraded';
}

async function fetchUptimeRobotPayload(apiKey, cacheSlot) {
  if (!apiKey) return null;
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(`https://multistreams.tv/api/status/_uptimerobot/${cacheSlot}`);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached.json().catch(() => null);
  }
  const body = new URLSearchParams({
    api_key: apiKey,
    format: 'json',
    logs: '1',
    logs_limit: '20',
    response_times: '1',
    response_times_limit: '30',
    custom_uptime_ratios: '30'
  });
  const response = await fetch(UPTIMEROBOT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.stat !== 'ok') throw new Error('The uptime service did not return a valid status response.');
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(payload), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${UPTIMEROBOT_CACHE_SECONDS}`
      }
    }));
  }
  return payload;
}

function normalizeUptimeRobotServices(payload) {
  return (payload?.monitors || []).map(monitor => {
    const responses = [...(monitor.response_times || [])]
      .sort((a, b) => Number(b.datetime || 0) - Number(a.datetime || 0));
    const latestResponse = responses[0] || null;
    const history = responses.slice(0, 30).reverse().map(sample => ({
      status: Number(sample.value || 0) > 0 ? 'operational' : 'degraded',
      responseTime: Number(sample.value || 0),
      checkedAt: sample.datetime ? new Date(Number(sample.datetime) * 1000).toISOString() : null
    }));
    while (history.length < 30) history.unshift({ status: 'unknown', responseTime: null, checkedAt: null });
    const incidents = (monitor.logs || []).filter(log => Number(log.type) === 1).map(log => ({
      id: String(log.id),
      reason: log.reason?.detail || 'Service interruption',
      startedAt: log.datetime ? new Date(Number(log.datetime) * 1000).toISOString() : null,
      durationSeconds: Number(log.duration || 0)
    }));
    incidents.forEach(incident => {
      if (!incident.startedAt) return;
      const target = history.reduce((nearest, sample, index) => {
        if (!sample.checkedAt) return nearest;
        const distance = Math.abs(new Date(sample.checkedAt).getTime() - new Date(incident.startedAt).getTime());
        return !nearest || distance < nearest.distance ? { index, distance } : nearest;
      }, null);
      if (target && target.distance <= 3_600_000) history[target.index] = { ...history[target.index], status: 'down' };
    });
    return {
      id: String(monitor.id),
      name: monitor.friendly_name || monitor.url || 'Service',
      url: monitor.url || '',
      status: monitorStatus(monitor.status),
      uptime: Number(monitor.custom_uptime_ratio || 0),
      responseTime: Number(latestResponse?.value || 0),
      latestCheck: latestResponse?.datetime ? new Date(Number(latestResponse.datetime) * 1000).toISOString() : null,
      history,
      incidents
    };
  });
}

function mergeUptimeRobotServices(serviceGroups) {
  const merged = new Map();
  serviceGroups.flat().forEach(service => {
    const existing = merged.get(service.id);
    if (!existing) {
      merged.set(service.id, service);
      return;
    }
    const incidents = new Map([...existing.incidents, ...service.incidents].map(incident => [incident.id, incident]));
    merged.set(service.id, {
      ...existing,
      name: existing.name || service.name,
      url: existing.url || service.url,
      status: existing.status === 'down' || service.status === 'down' ? 'down'
        : existing.status === 'degraded' || service.status === 'degraded' ? 'degraded' : 'operational',
      uptime: Number.isFinite(service.uptime) && service.uptime > 0 ? service.uptime : existing.uptime,
      responseTime: service.latestCheck && (!existing.latestCheck || service.latestCheck > existing.latestCheck)
        ? service.responseTime : existing.responseTime,
      latestCheck: [existing.latestCheck, service.latestCheck].filter(Boolean).sort().pop() || null,
      history: (service.history || []).some(period => period.checkedAt) ? service.history : existing.history,
      incidents: [...incidents.values()].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
    });
  });
  return [...merged.values()];
}

async function uptimeRobotStatus(env) {
  const keyEntries = [
    ['monitors', env.UPTIMEROBOT_API_KEY],
    ['response', env.UPTIMEROBOT_RESPONSE_API_KEY]
  ].filter(([, key], index, entries) => key && entries.findIndex(([, candidate]) => candidate === key) === index);
  if (!keyEntries.length) return { services: [], hadError: false };
  const results = await Promise.allSettled(keyEntries.map(([slot, key]) => fetchUptimeRobotPayload(key, slot)));
  const services = mergeUptimeRobotServices(results
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => normalizeUptimeRobotServices(result.value)));
  return { services, hadError: results.some(result => result.status === 'rejected') };
}

async function status(request, env) {
  const started = Date.now();
  let services = [];
  let source = 'health';
  let warning = '';
  try {
    const uptime = await uptimeRobotStatus(env);
    services = uptime.services;
    if (uptime.hadError) warning = services.length
      ? 'Some uptime history is temporarily unavailable.'
      : 'Uptime history is temporarily unavailable.';
    if (services.length) source = 'uptimerobot';
  } catch (error) {
    warning = error.message || 'Uptime history is temporarily unavailable.';
  }
  if (!services.length) {
    const database = await env.DB.prepare('SELECT 1 AS healthy').first();
    services = [{
      id: 'multistreams-api',
      name: 'Multistreams.tv',
      url: new URL(env.APP_ORIGIN).origin,
      status: database?.healthy === 1 ? 'operational' : 'degraded',
      uptime: null,
      responseTime: Date.now() - started,
      latestCheck: new Date().toISOString(),
      history: Array.from({ length: 30 }, (_, index) => ({
        status: index === 29 ? (database?.healthy === 1 ? 'operational' : 'degraded') : 'unknown',
        responseTime: index === 29 ? Date.now() - started : null,
        checkedAt: index === 29 ? new Date().toISOString() : null
      })),
      incidents: []
    }];
  }
  const overall = services.some(service => service.status === 'down') ? 'down'
    : services.some(service => service.status === 'degraded') ? 'degraded' : 'operational';
  return json({ ok: true, status: overall, source, warning, checkedAt: new Date().toISOString(), services }, {
    headers: { 'cache-control': 'private, max-age=30' }
  });
}

export async function handleStatusRoute(request, env, url) {
  if (url.pathname === '/api/status' && request.method === 'GET') return status(request, env);
  return null;
}
