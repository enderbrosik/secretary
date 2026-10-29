// Prepares the local-mode sidecar for `tauri build`:
//  1. builds the server bundle,
//  2. copies it (plus migrations and the PGlite runtime) into src-tauri/resources/server,
//  3. copies the current Node.js executable to src-tauri/binaries/node-<target-triple>.
// Run on each target OS (CI does this per platform) so the Node binary matches the target.
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const tauriDir = path.resolve(here, '../src-tauri');

execSync('pnpm --filter @secretary/server build', { cwd: root, stdio: 'inherit' });

const out = path.join(tauriDir, 'resources/server');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'apps/server/dist'), out, { recursive: true });
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'module', private: true }));

// PGlite ships WASM + data files resolved relative to its own module, so copy the package as-is.
const pgliteDir = realpathSync(path.join(root, 'packages/db/node_modules/@electric-sql/pglite'));
cpSync(pgliteDir, path.join(out, 'node_modules/@electric-sql/pglite'), { recursive: true, dereference: true });

const triple = execFileSync('rustc', ['--print', 'host-tuple']).toString().trim() || execFileSync('rustc', ['-vV']).toString().match(/host: (.+)/)[1];
const binDir = path.join(tauriDir, 'binaries');
mkdirSync(binDir, { recursive: true });
const target = path.join(binDir, `secretary-node-${triple}${process.platform === 'win32' ? '.exe' : ''}`);
cpSync(process.execPath, target);
if (process.platform !== 'win32') chmodSync(target, 0o755);
console.log(`Sidecar ready: ${path.relative(root, target)} (+ resources/server)`);
if (!existsSync(path.join(out, 'main.mjs'))) throw new Error('server bundle missing');
