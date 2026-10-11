// Starts Electron for local runs. Clears ELECTRON_RUN_AS_NODE, which some terminals
// (e.g. VS Code's) set and which makes Electron behave like plain Node and exit.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.resolve(here, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
