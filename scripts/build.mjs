import { mkdir, copyFile, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'public');
const files = ['index.html', 'style.css', 'levels.js', 'audio.js', 'game.js'];
await mkdir(output, { recursive: true });
for (const name of await readdir(output)) {
  if (!files.includes(name)) await unlink(join(output, name));
}
for (const name of files) await copyFile(join(root, name), join(output, name));
console.log(`Built ${files.length} static game files into public/`);
