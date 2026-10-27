// Сборка Termuxx для Windows: main (Node), preload (Node, sandbox-friendly), renderer (браузер).
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const prod = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info', legalComments: 'none' };

mkdirSync('dist', { recursive: true });

await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main.js',
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // Нативные модули и electron не бандлим.
  external: ['electron', 'node-pty', 'ssh2', 'cpu-features'],
});

await build({
  ...common,
  entryPoints: ['src/preload/preload.ts'],
  outfile: 'dist/preload.js',
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: ['src/renderer/index.tsx'],
  outfile: 'dist/renderer/app.js',
  platform: 'browser',
  target: 'chrome140',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file' },
  define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
});

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('build/fonts', 'dist/renderer/fonts', { recursive: true });
console.log('build ok');
