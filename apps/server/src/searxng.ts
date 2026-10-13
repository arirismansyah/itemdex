// Starts the local SearXNG (tools/searxng) together with the service, so price
// checks work without a second terminal. Only when SEARCH_URL points at this
// machine, nothing answers there yet, and the repo's install exists; otherwise a no-op.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findUp, type Config } from './config.js';

interface Log { info: (m: string) => void; warn: (m: string) => void }

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

async function healthy(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

// Returns a function that stops the child (no-op when nothing was started).
export async function autostartSearch(cfg: Config['search'], log: Log): Promise<() => void> {
  const noop = () => {};
  if (!cfg.url || !cfg.autostart) return noop;
  let target: URL;
  try { target = new URL(cfg.url); } catch { return noop; }
  if (!LOCAL_HOSTS.includes(target.hostname)) return noop;
  if (await healthy(cfg.url)) {
    log.info(`price search: using SearXNG already running at ${cfg.url}`);
    return noop;
  }

  const script = findUp('tools/searxng/start.sh', process.cwd(), 4);
  if (!script || !fs.existsSync(path.join(path.dirname(script), '.venv', 'bin', 'python'))) {
    log.warn('price search: SearXNG is not installed, price checks are off. Install once with: npm run search:setup');
    return noop;
  }

  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const child: ChildProcess = spawn('bash', [script], {
    env: { ...process.env, SEARXNG_PORT: port, SEARXNG_BIND_ADDRESS: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let lastErr = '';
  child.stderr?.on('data', (b: Buffer) => { lastErr = b.toString().trim().split('\n').pop() || lastErr; });
  child.on('exit', (code) => {
    if (code) log.warn(`price search: SearXNG exited (code ${code})${lastErr ? `: ${lastErr}` : ''}`);
  });

  const stop = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
  process.once('exit', stop); // last resort if the service dies without closing

  // Report readiness in the background; the service doesn't wait for it.
  void (async () => {
    for (let i = 0; i < 40 && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await healthy(cfg.url)) {
        log.info(`price search: started SearXNG at ${cfg.url}`);
        return;
      }
    }
    if (child.exitCode === null) log.warn(`price search: SearXNG did not become ready at ${cfg.url}`);
  })();

  return stop;
}
