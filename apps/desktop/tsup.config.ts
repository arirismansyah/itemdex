import { defineConfig } from 'tsup';

// Everything (service, Fastify, pg) is bundled into dist/main.cjs, so the packaged
// app ships no node_modules at all: smaller install, faster startup.
export default defineConfig({
  entry: { main: 'src/main.ts', preload: 'src/preload.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node22',
  // Bundle everything except: electron (runtime), pg-native (optional), and the
  // Swagger UI deps (API docs are disabled in the desktop app).
  // (tsup's `noExternal` wins over `external`, so the exclusions live in the regex.)
  noExternal: [/^(?!electron$|pg-native$|playwright-core$|@fastify\/swagger|yaml$).*/],
  external: ['electron', 'pg-native', 'playwright-core', '@fastify/swagger', '@fastify/swagger-ui', 'yaml'],
  clean: true,
  minify: true,
  sourcemap: false,
});
