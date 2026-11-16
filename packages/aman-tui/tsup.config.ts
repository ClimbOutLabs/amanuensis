import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['@truefoundry/trueforge-chat', '@truefoundry/trueforge-sdk', 'ink', 'react'],
});
