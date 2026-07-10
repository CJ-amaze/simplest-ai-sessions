import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
});
mkdirSync('resources', { recursive: true });
mkdirSync('dist/resources', { recursive: true });
cpSync('resources', 'dist/resources', { recursive: true });
console.log('build ok');
