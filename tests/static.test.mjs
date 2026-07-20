import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../multistreams.tv/multistreams.html', import.meta.url), 'utf8');
const backendClient = await readFile(new URL('../multistreams.tv/backend-client.js', import.meta.url), 'utf8');
const contactClient = await readFile(new URL('../multistreams.tv/contact.js', import.meta.url), 'utf8');

test('no provider API keys, OAuth bearer tokens, or Discord webhooks remain in frontend source', () => {
  assert.doesNotMatch(html, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(html, /discord\.com\/api\/webhooks\//);
  assert.doesNotMatch(html, /YB3lxGALkuaqHAf31EQcMwKfWlt1/);
  assert.doesNotMatch(html, /Bearer\s+[0-9a-z]{20,}/i);
  assert.doesNotMatch(backendClient, /x-goog-api-key|client_secret|discord\.com\/api\/webhooks\//i);
  assert.doesNotMatch(contactClient, /x-api-key|client_secret|discord\.com\/api\/webhooks\//i);
});

test('all inline classic scripts and the backend client parse as JavaScript', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  scripts.forEach((source, index) => assert.doesNotThrow(() => new vm.Script(source, { filename: `multistreams-inline-${index}.js` })));
  assert.doesNotThrow(() => new vm.Script(backendClient, { filename: 'backend-client.js' }));
  assert.match(html, /<script src="backend-client\.js"><\/script>/);
});
