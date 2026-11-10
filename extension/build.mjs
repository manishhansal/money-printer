/**
 * Extension build script — bundles TypeScript source files using esbuild
 * and copies HTML assets to the dist/ output directory.
 *
 * Usage:
 *   node extension/build.mjs          # one-shot build
 *   node extension/build.mjs --watch  # rebuild on file changes
 */

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, 'src');
const dist = join(__dirname, 'dist');
const watch = process.argv.includes('--watch');

// ── Entry points ─────────────────────────────────────────────────────────────
const entryPoints = [
  { in: join(src, 'background', 'background.ts'), out: join('dist', 'background', 'background') },
  { in: join(src, 'popup', 'popup.ts'),           out: join('dist', 'popup', 'popup') },
  { in: join(src, 'sidepanel', 'sidepanel.ts'),   out: join('dist', 'sidepanel', 'sidepanel') },
  { in: join(src, 'dashboard', 'dashboard.ts'),   out: join('dist', 'dashboard', 'dashboard') },
];

// ── esbuild config ────────────────────────────────────────────────────────────
const buildConfig = {
  entryPoints: entryPoints.map(e => e.in),
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',          // IIFE — no ES module import/export issues in Chrome
  outdir: dist,
  outbase: src,
  sourcemap: true,
  logLevel: 'info',
};

// ── Copy HTML assets to dist ──────────────────────────────────────────────────
function copyAssets() {
  const htmlFiles = [
    { from: join(src, 'popup', 'popup.html'),         to: join(dist, 'popup', 'popup.html') },
    { from: join(src, 'sidepanel', 'sidepanel.html'), to: join(dist, 'sidepanel', 'sidepanel.html') },
  ];

  for (const { from, to } of htmlFiles) {
    mkdirSync(dirname(to), { recursive: true });
    try {
      cpSync(from, to);
      console.log(`Copied: ${from.replace(__dirname, '.')} → ${to.replace(__dirname, '.')}`);
    } catch {
      // File may not exist — skip silently
    }
  }
}

// ── Build ─────────────────────────────────────────────────────────────────────
if (watch) {
  const ctx = await esbuild.context({
    ...buildConfig,
    plugins: [{
      name: 'copy-assets',
      setup(build) {
        build.onEnd(() => copyAssets());
      },
    }],
  });
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildConfig);
  copyAssets();
  console.log('\n✓ Extension built to extension/dist/');
}
