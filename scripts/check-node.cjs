// Fails fast with a clear message when Node is too old. Older versions crash deep
// inside dependencies instead (ERR_REQUIRE_ESM from @fastify/static, util.styleText in Vite).
var v = process.versions.node.split('.').map(Number);
var major = v[0], minor = v[1];
var ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;
if (!ok) {
  console.error('\nITEMDEX needs Node 20.19+ or 22.12+ (recommended: 22, see .nvmrc). You are on ' + process.version + '.');
  console.error('Fix:  nvm use        (or once for all terminals: nvm alias default 22)\n');
  process.exit(1);
}
