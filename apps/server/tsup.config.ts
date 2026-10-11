import { defineConfig } from 'tsup';

// Standalone service bundle: our code + @itemdex/shared inlined, npm deps stay external.
export default defineConfig({
  entry: { index: 'src/index.ts', migrate: 'src/migrate.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  noExternal: ['@itemdex/shared'],
  clean: true,
  sourcemap: true,
});
