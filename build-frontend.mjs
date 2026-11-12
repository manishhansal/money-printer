/**
 * build-frontend.mjs — Builds the MoneyPrinter React trading terminal.
 *
 * Output: public/app.js + public/app.js.map
 * Entry:  src/frontend/index.tsx
 *
 * Usage:
 *   node build-frontend.mjs         # one-shot build
 *   node build-frontend.mjs --watch # rebuild on file changes
 */

import * as esbuild from 'esbuild';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

mkdirSync(join(__dirname, 'public'), { recursive: true });

const buildConfig = {
  entryPoints: [join(__dirname, 'src', 'frontend', 'index.tsx')],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  outfile: join(__dirname, 'public', 'app.js'),
  sourcemap: true,
  jsx: 'transform',           // classic React (React.createElement)
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

if (watch) {
  const ctx = await esbuild.context(buildConfig);
  await ctx.watch();
  console.log('Frontend watching for changes...');
} else {
  await esbuild.build(buildConfig);
  console.log('\n✓ Frontend built → public/app.js');
}
