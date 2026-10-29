import { build } from 'esbuild';
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(out, 'main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // PGlite carries WASM/data files resolved from its own folder, so it stays external and is copied next to the bundle.
  external: ['pg-native', '@electric-sql/pglite'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
cpSync(path.join(here, '../../packages/db/migrations'), path.join(out, 'migrations'), { recursive: true });
// Make dist/ self-contained: PGlite (WASM + data files) next to the bundle, ESM package marker.
cpSync(realpathSync(path.join(here, '../../packages/db/node_modules/@electric-sql/pglite')), path.join(out, 'node_modules/@electric-sql/pglite'), { recursive: true, dereference: true });
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'module', private: true }));
console.log('Server bundle written to dist/ (self-contained: node dist/main.mjs)');
