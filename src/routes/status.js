import { json } from '../lib/http.js';

function monitorStatus(value) {
  if (Number(value) === 2) return 'operational';
  if ([8, 9].includes(Number(value))) return 'down';
  return 'degraded';
}

async function uptimeRobotStatus(env) {
  if (!env.UPTIMEROBOT_API_KEY) return null;
  const body = new URLSearchParams({
    api_key: env.UPTIMEROBOT_API_KEY,
    format: 'json',
    logs: '1',
    logs_limit: '20',
    response_times: '1',
    response_times_limit: '24',
    custom_uptime_ratios: '30'
  });
  const response = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    cf: { cacheTtl: 60, cacheEverything: true }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.stat !== 'ok') throw new Error('The uptime service did not return a valid status response.');
  const services = (payload.monitors || []).map(monitor => {
    const responses = monitor.response_times || [];
    const latestResponse = responses.length ? responses[responses.length - 1] : null;
    return {
      id: String(monitor.id),
      name: monitor.friendly_name || monitor.url || 'Service',
      url: monitor.url || '',
      status: monitorStatus(monitor.status),
      uptime: Number(monitor.custom_uptime_ratio || 0),
      responseTime: Number(latestResponse?.value || 0),
      latestCheck: latestResponse?.datetime ? new Date(Number(latestResponse.datetime) * 1000).toISOString() : null,
      incidents: (monitor.logs || []).filter(log => Number(log.type) === 1).map(log => ({
        id: String(log.id),
        reason: log.reason?.detail || 'Service interruption',
        startedAt: log.datetime ? new Date(Number(log.datetime) * 1000).toISOString() : null,
        durationSeconds: Number(log.duration || 0)
      }))
    };
  });
  return services;
}

async function status(request, env) {
  const started = Date.now();
  let services = [];
  let source = 'health';
  let warning = '';
  try {
    services = await uptimeRobotStatus(env) || [];
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
