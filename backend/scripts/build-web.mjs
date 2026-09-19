// Makes sure the repository-root web UI is built and current before the demo starts.
// - installs root dependencies on first run
// - rebuilds only when source is newer than dist (so restarts stay fast)
// - never blocks the API: if the UI build fails it warns and lets the backend start anyway
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, '..');
const dist = join(web, 'dist', 'index.html');

function newest(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = st.mtimeMs;
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name === 'dist' || name.endsWith('.tsbuildinfo')) continue;
    m = Math.max(m, newest(join(path, name)));
  }
  return m;
}

function run(args, label) {
  // one fixed command string (no user input), which is what a shell wants; passing an args array with shell:true is deprecated
  const r = spawnSync(`npm ${args.join(' ')}`, { cwd: web, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

if (!existsSync(join(web, 'package.json'))) {
  console.warn('[web] frontend not found: starting the API without a UI');
  process.exit(0);
}

try {
  if (!existsSync(join(web, 'node_modules'))) {
    console.log('[web] installing web/ dependencies (first run)...');
    run(['install', '--no-audit', '--no-fund'], 'npm install');
  }
  const stale = !existsSync(dist) || newest(web) > statSync(dist).mtimeMs;
  if (stale) {
    console.log('[web] building web/ ...');
    run(['run', 'build'], 'web build');
  } else {
    console.log('[web] web/dist is up to date');
  }
} catch (err) {
  console.warn(`[web] ${err.message}. ${existsSync(dist) ? 'Serving the previous build.' : 'Starting the API without a UI.'}`);
}
