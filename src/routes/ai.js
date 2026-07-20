import { HttpError, json, readJson } from '../lib/http.js';
import { rateLimit, requireSession } from '../lib/db.js';

const MODELS = Object.freeze([
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' }
]);

function mergeSystemInstruction(contents, instruction) {
  const cloned = structuredClone(contents);
  const text = String(instruction || '').trim();
  if (!text) return cloned;
  const firstUser = cloned.find(item => item?.role === 'user' && Array.isArray(item.parts));
  if (firstUser) firstUser.parts.unshift({ text: `System instructions:\n${text}\n\nUser request:` });
  else cloned.unshift({ role: 'user', parts: [{ text: `System instructions:\n${text}` }] });
  return cloned;
}

async function requestGemini(env, model, contents, systemInstruction, googleSearch) {
  if (env.GEMINI_BACKEND_URL) {
    const response = await fetch(env.GEMINI_BACKEND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env.GEMINI_BACKEND_ORIGIN || 'https://htmlviewer.site'
      },
      body: JSON.stringify({
        model,
        contents: mergeSystemInstruction(contents, systemInstruction),
        googleSearch: googleSearch !== false
      })
    });
    return { response, result: await response.json().catch(() => ({})) };
  }
  if (!env.GEMINI_API_KEY) throw new HttpError(503, 'AI Search is not configured.', 'ai_not_configured');
  const payload = {
    contents,
    systemInstruction: { parts: [{ text: String(systemInstruction || '').slice(0, 24_000) }] },
    generationConfig: { temperature: 0.35, maxOutputTokens: 12_000, responseMimeType: 'application/json' }
  };
  if (googleSearch !== false) payload.tools = [{ googleSearch: {} }];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(payload)
  });
  return { response, result: await response.json().catch(() => ({})) };
}

async function aiSearch(request, env) {
  const session = await requireSession(request, env);
  await rateLimit(env, `ai:${session.user_id}`, 30, 3600);
  const body = await readJson(request, 96_000);
  const model = MODELS.some(item => item.id === body.model) ? body.model : MODELS[0].id;
  const contents = Array.isArray(body.contents) ? body.contents.slice(-20) : [];
  if (!contents.length) throw new HttpError(400, 'A search message is required.', 'ai_prompt_required');
  const { response, result } = await requestGemini(env, model, contents, body.systemInstruction, body.googleSearch);
  if (!response.ok) {
    console.error(JSON.stringify({ event: 'gemini_api_error', status: response.status, code: result.error?.status || '', message: result.error?.message || '' }));
    throw new HttpError(response.status === 429 ? 429 : 502, result.error?.message || 'Gemini could not complete the search.', 'gemini_api_error');
  }
  return json({ ok: true, model, response: result });
}

export async function handleAiRoute(request, env, url) {
  if (url.pathname === '/api/ai/models' && request.method === 'GET') return json({ ok: true, models: MODELS, defaultModel: MODELS[0].id });
  if (url.pathname === '/api/ai/search' && request.method === 'POST') return aiSearch(request, env);
  return null;
}

export { MODELS };
