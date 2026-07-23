import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'multistreams.tv');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(source, dist, { recursive: true });
await cp(resolve(root, 'logos and assets'), resolve(dist, 'logos and assets'), { recursive: true });
await cp(resolve(root, 'COLLECTIBLE CARD IMAGES'), resolve(dist, 'COLLECTIBLE CARD IMAGES'), { recursive: true });

const routablePages = (await readdir(source))
  .filter(file => file.endsWith('.html') && !/^google[a-z0-9_-]+\.html$/i.test(file))
  .map(file => file.slice(0, -'.html'.length));
const routePattern = new RegExp(`\\b(${routablePages.join('|')})\\.html\\b`, 'g');

function cleanPageLinks(html) {
  return html.replace(routePattern, (_match, page) => `/${page}`);
}

function addRootBase(html) {
  if (/<base\s/i.test(html)) return html;
  return html.replace(/<head(\s[^>]*)?>/i, match => `${match}\n  <base href="/">`);
}

for (const page of routablePages) {
  const html = cleanPageLinks(await readFile(resolve(source, `${page}.html`), 'utf8'));
  await writeFile(resolve(dist, `${page}.html`), html, 'utf8');
  await mkdir(resolve(dist, page), { recursive: true });
  await writeFile(resolve(dist, page, 'index.html'), addRootBase(html), 'utf8');
}

const home = cleanPageLinks(await readFile(resolve(source, 'home.html'), 'utf8'));
await writeFile(resolve(dist, 'index.html'), home, 'utf8');
