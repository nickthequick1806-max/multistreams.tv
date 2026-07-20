import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'multistreams.tv');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(source, dist, { recursive: true });
await cp(resolve(root, 'logos and assets'), resolve(dist, 'logos and assets'), { recursive: true });
await cp(resolve(root, 'COLLECTIBLE CARD IMAGES'), resolve(dist, 'COLLECTIBLE CARD IMAGES'), { recursive: true });

const home = await readFile(resolve(source, 'home.html'), 'utf8');
await writeFile(resolve(dist, 'index.html'), home, 'utf8');

