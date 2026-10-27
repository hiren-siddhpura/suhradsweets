import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const failures = [];
const allowed = /^(index\.html|offline\.html|manifest\.webmanifest|sw\.js|logo\.png|css\/[^/]+\.css|js\/[^/]+\.js|logo\/[^/]+\.(png|jpg|jpeg|svg)|fonts\/[^/]+\.(ttf|txt)|icons\/icon-(192|512)\.png)$/;

function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) scan(file);
    else {
      const relative = file.slice(dist.length + 1).replaceAll('\\', '/');
      if (!allowed.test(relative)) failures.push(`Unexpected Hosting artifact: ${relative}`);
      if (statSync(file).size > 25 * 1024 * 1024) failures.push(`Hosting artifact exceeds 25 MiB: ${relative}`);
      if (relative.endsWith('.js')) {
        const source = readFileSync(file, 'utf8');
        if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|"private_key"\s*:|FIREBASE_SERVICE_ACCOUNT/.test(source)) failures.push(`Possible credential in public JavaScript: ${relative}`);
        if (/demo-suh-oms|demo-local-key|127\.0\.0\.1|localhost:9099/.test(source)) failures.push(`Local emulator configuration in public JavaScript: ${relative}`);
      }
    }
  }
}

scan(dist);
const hosting = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')).hosting;
if (hosting.public !== 'dist') failures.push('Firebase Hosting must publish only dist.');

if (failures.length) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exitCode = 1;
} else process.stdout.write('Static Hosting artifact check passed.\n');
