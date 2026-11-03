// The embeddable viewer's builds. See docs/architecture/viewer.md.
//
// - `pnpm --filter @golemdocs/client build:viewer`: viewer.html and everything it loads, in dist-viewer/, with relative paths so the
//   folder works wherever a host puts it, and the fonts it needs in dist-viewer/fonts/: for another app to bundle.
// - `--mode site` (part of the client's `build`): the site's page for documents shared view-only (view/index.html, at /view/), written
//   into the site's dist/ after the app's own build, with the site's fonts.
//
// Either way the app's build (vite.config.ts) is left as it is: the viewer is a build of its own, so it adds no chunk to the app.
//
// VIEWER_FONTS (comma-separated family ids, or `all`, `extras`, `cjk`) changes the font set, VIEWER_FONT_FILES=1 adds the .ttf files.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, mergeConfig, type Plugin, type PluginOption } from 'vite';
import app from './vite.config.ts';
import { VIEWER_FONTS, viewerFontSet } from './src/viewer/fonts.ts';

const FONTS = path.resolve(import.meta.dirname, 'public/fonts');

/** Writes the viewer's font set (see src/viewer/fonts.ts) into the build's fonts/ folder. */
function viewerFonts(): Plugin {
  return {
    name: 'viewer-fonts',
    apply: 'build',
    generateBundle() {
      const families = process.env.VIEWER_FONTS ? process.env.VIEWER_FONTS.split(',') : VIEWER_FONTS;
      const set = viewerFontSet(JSON.parse(readFileSync(path.join(FONTS, 'manifest.json'), 'utf8')), families, process.env.VIEWER_FONT_FILES === '1');
      this.emitFile({ type: 'asset', fileName: 'fonts/manifest.json', source: JSON.stringify(set.manifest) });
      let bytes = 0;
      for (const file of set.files) {
        const source = readFileSync(path.join(FONTS, file));
        bytes += source.length;
        this.emitFile({ type: 'asset', fileName: `fonts/${file}`, source });
      }
      this.info(`fonts: ${set.manifest.families.map((f) => f.id).join(', ')} (${set.files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    },
  };
}

/** The app's own UI font is a web font of the site's: the viewer uses the system's (viewer.css), and doesn't even declare it, or WebKit fetches it anyway. */
function noUiFont(): Plugin {
  return {
    name: 'viewer-no-ui-font',
    transform(code, id) {
      if (/[\\/]ui[\\/]ui\.css$/.test(id)) return code.replace(/@font-face\s*\{[^}]*\}/g, '');
    },
  };
}

/** The app's config without what belongs to the app's own build: its build id (build.json, which the viewer must not overwrite) and its marketing pages. */
const appConfig = { ...app, plugins: (app.plugins ?? []).filter((p: PluginOption) => !(p && 'name' in p && (p.name === 'build-id' || p.name === 'welcome-content'))) };

export default defineConfig(({ mode }) =>
  mergeConfig(appConfig, {
    // Nothing the viewer runs checks the build id; it is defined for any module that names it.
    define: { __BUILD_ID__: JSON.stringify('') },
    // The site's public files (every font, the dictionaries, the marketing pages) are not the viewer's: its fonts are written by
    // viewerFonts, and on the site the app's build has already copied them.
    publicDir: false,
    ...(mode === 'site'
      ? {
          plugins: [noUiFont()],
          // Into the site's own output, beside the app (whose files it leaves).
          build: { outDir: 'dist', emptyOutDir: false, rollupOptions: { input: { view: path.resolve(import.meta.dirname, 'view/index.html') } } },
        }
      : {
          base: './',
          plugins: [viewerFonts(), noUiFont()],
          build: { outDir: 'dist-viewer', emptyOutDir: true, rollupOptions: { input: { viewer: path.resolve(import.meta.dirname, 'viewer.html') } } },
        }),
  }),
);
