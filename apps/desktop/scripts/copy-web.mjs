// Copies the built web app (apps/web/dist) into dist/web for packaging.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../web/dist');
const dest = path.resolve(here, '../dist/web');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('apps/web/dist not found: run `npm run build -w @itemdex/web` first');
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`copied web app -> ${path.relative(process.cwd(), dest)}`);
