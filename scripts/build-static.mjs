import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const paths = ['index.html', 'offline.html', 'manifest.webmanifest', 'sw.js', 'logo.png', 'css', 'js', 'logo', 'fonts', 'icons'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const path of paths) {
  const source = resolve(root, path);
  const details = await stat(source);
  await cp(source, resolve(dist, path), { recursive: details.isDirectory(), force: true });
}
process.stdout.write(`Built static Hosting artifact: ${dist}\n`);
