// Generates MSDF font atlases for the Word font substitutes listed in sources.ts.
//
//   pnpm fonts                     all families
//   pnpm fonts --only calibri,arial
//   pnpm fonts --download-only     fetch and verify sources, skip atlas generation
//
// Output (served by the client's Vite dev server at /fonts/):
//   client/public/fonts/manifest.json           Word font name -> faces, atlases and metrics
//   client/public/fonts/<id>/<face>.webp        MTSDF atlas (lossless WebP)
//   client/public/fonts/<id>/<face>.json        glyph layout (msdf-atlas-gen JSON)
//   client/public/fonts/<id>/LICENSE.txt
//
// Downloads and the msdf-atlas-gen build are cached in .cache/. msdf-atlas-gen is built
// from a pinned commit on first run; that needs git, cmake, a C++ compiler, FreeType and
// libpng (macOS: `brew install cmake freetype libpng`). Set MSDF_ATLAS_GEN to use an
// existing binary instead.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVES, ATLAS, FAMILIES, MSDF_ATLAS_GEN, type FaceSpec, type FamilySpec, type FileRef } from './sources.ts';
import { readFontMetrics, type FontMetrics } from './ttf-metrics.ts';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'client', 'public', 'fonts');
const CHARSET = path.join(HERE, 'charset.txt');

interface ManifestFace {
  weight: number;
  italic: boolean;
  /** Paths relative to the manifest. */
  atlas: string;
  layout: string;
  /** Font-wide metrics in font units. */
  metrics: FontMetrics;
}

interface ManifestFamily {
  id: string;
  wordName: string;
  substitute: string;
  license: string;
  licenseFile: string;
  aliases: Record<string, number>;
  faces: ManifestFace[];
  cjk?: { lang: 'ja' | 'zh-Hant' | 'ko'; order: number; coverage: string };
}

interface Manifest {
  atlas: typeof ATLAS & { generator: string };
  families: ManifestFamily[];
}

// ---------------------------------------------------------------------------------------

/** Runs a command. With `quiet`, output is captured and returned (and printed only on failure). */
function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}): string {
  const result = spawnSync(cmd, args, { cwd: opts.cwd, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    if (opts.quiet) process.stderr.write(output);
    throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`);
  }
  return output;
}

function hasCommand(cmd: string): boolean {
  return !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function download(url: string, expected: string): Promise<string> {
  const dest = path.join(CACHE, 'downloads', expected);
  if (existsSync(dest)) return dest;
  console.log(`  download ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}`);
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(`${dest}.tmp`, data);
  renameSync(`${dest}.tmp`, dest);
  return dest;
}

async function resolveFile(ref: FileRef): Promise<string> {
  if ('url' in ref) return download(ref.url, ref.sha256);

  const archive = ARCHIVES[ref.archive];
  const dir = path.join(CACHE, 'extracted', archive.sha256);
  if (!existsSync(path.join(dir, '.complete'))) {
    const file = await download(archive.url, archive.sha256);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (archive.format === 'zip') run('unzip', ['-q', '-o', file, '-d', dir]);
    else run('tar', ['-xzf', file, '-C', dir]);
    writeFileSync(path.join(dir, '.complete'), '');
  }
  const file = path.join(dir, ref.path);
  if (!existsSync(file)) throw new Error(`${ref.path} not found in ${archive.url}`);
  return file;
}

function ensureMsdfAtlasGen(): string {
  const fromEnv = process.env.MSDF_ATLAS_GEN;
  if (fromEnv) return fromEnv;

  const src = path.join(CACHE, 'msdf-atlas-gen', MSDF_ATLAS_GEN.commit);
  const bin = path.join(src, 'build', 'bin', 'msdf-atlas-gen');
  if (existsSync(bin)) return bin;

  for (const cmd of ['git', 'cmake']) {
    if (!hasCommand(cmd)) {
      throw new Error(
        `${cmd} is required to build msdf-atlas-gen.\n` +
          `  macOS: brew install cmake freetype libpng\n` +
          `  Debian/Ubuntu: apt install git cmake g++ libfreetype-dev libpng-dev`,
      );
    }
  }

  console.log(`Building msdf-atlas-gen @ ${MSDF_ATLAS_GEN.commit.slice(0, 10)} (one time)…`);
  if (!existsSync(path.join(src, '.git'))) {
    rmSync(src, { recursive: true, force: true });
    mkdirSync(path.dirname(src), { recursive: true });
    run('git', ['clone', '--quiet', MSDF_ATLAS_GEN.repo, src]);
  }
  run('git', ['checkout', '--quiet', MSDF_ATLAS_GEN.commit], { cwd: src });
  run('git', ['submodule', 'update', '--init', '--recursive', '--quiet'], { cwd: src });
  try {
    run('cmake', [
      '-S', '.', '-B', 'build',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DMSDF_ATLAS_USE_VCPKG=OFF',
      '-DMSDF_ATLAS_USE_SKIA=OFF',
      '-DMSDF_ATLAS_NO_ARTERY_FONT=ON',
      '-DMSDFGEN_DISABLE_SVG=ON',
    ], { cwd: src, quiet: true });
    run('cmake', ['--build', 'build', '--config', 'Release', '--parallel'], { cwd: src, quiet: true });
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\n` +
        `msdf-atlas-gen failed to build. It needs FreeType and libpng:\n` +
        `  macOS: brew install freetype libpng\n` +
        `  Debian/Ubuntu: apt install libfreetype-dev libpng-dev`,
    );
  }
  if (!existsSync(bin)) throw new Error(`msdf-atlas-gen built but ${bin} is missing`);
  return bin;
}

function faceName(face: FaceSpec): string {
  const weights: Record<number, string> = { 300: 'light', 350: 'semilight', 400: 'regular', 600: 'semibold', 700: 'bold' };
  const weight = weights[face.weight] ?? String(face.weight);
  if (!face.italic) return weight;
  return face.weight === 400 ? 'italic' : `${weight}-italic`;
}

/**
 * Converts msdf-atlas-gen's PNG to lossless WebP and verifies the round trip is bit-exact.
 * Lossy WebP would shift the distance values and make glyph edges wobble. `exact` is
 * required: without it the encoder rewrites RGB under fully transparent pixels, which
 * corrupts the MSDF channels (the true distance lives in alpha, the MSDF in RGB).
 */
async function pngToWebp(png: string, webp: string): Promise<void> {
  const source = await sharp(png).ensureAlpha().raw().toBuffer();
  const encoded = await sharp(png).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
  const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer();
  if (!source.equals(decoded)) throw new Error(`lossless WebP round trip changed pixels in ${png}`);
  writeFileSync(webp, encoded);
}

/**
 * Writes `<family>/coverage.json`, the code points a generated layout has glyphs for as a flat list of
 * inclusive ranges `[from, to, from, to, …]`, and returns its path relative to the manifest. It is a
 * separate small file, fetched only for documents with CJK text, so the manifest every user loads
 * stays small.
 */
function writeCoverage(id: string, layoutPath: string): string {
  const layout = JSON.parse(readFileSync(path.join(OUT, layoutPath), 'utf8')) as { glyphs: { unicode?: number }[] };
  const cps = layout.glyphs.flatMap((g) => (g.unicode === undefined ? [] : [g.unicode])).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const cp of cps) {
    const last = ranges[ranges.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else if (!last || cp > last[1]) ranges.push([cp, cp]);
  }
  writeFileSync(path.join(OUT, id, 'coverage.json'), JSON.stringify(ranges.flat()));
  return `${id}/coverage.json`;
}

async function generateFace(tool: string, family: FamilySpec, face: FaceSpec, fontPath: string): Promise<ManifestFace> {
  const name = faceName(face);
  const dir = path.join(OUT, family.id);
  const tmp = path.join(CACHE, 'tmp');
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const png = path.join(tmp, `${family.id}-${name}.png`);

  const input = face.variations
    ? ['-varfont', `${fontPath}?${Object.entries(face.variations).map(([axis, value]) => `${axis}=${value}`).join('&')}`]
    : ['-font', fontPath];

  const atlas = family.atlas ?? ATLAS;
  const output = run(tool, [
    ...input,
    '-charset', family.charset ? path.join(HERE, 'charsets', family.charset) : CHARSET,
    '-fontname', `${family.substitute} ${name}`,
    '-type', atlas.type,
    '-size', String(atlas.size),
    '-pxrange', String(atlas.pxrange),
    ...(family.atlas ? ['-dimensions', ...family.atlas.dimensions.map(String)] : []),
    '-yorigin', ATLAS.yOrigin,
    '-imageout', png,
    '-json', path.join(dir, `${name}.json`),
  ], { quiet: true });

  // Characters in charset.txt that the font doesn't have; the renderer needs a fallback for these.
  const missing = output.match(/^Missing \d+ codepoints?: .*$/m);
  if (missing) console.log(`    ${missing[0]}`);

  await pngToWebp(png, path.join(dir, `${name}.webp`));
  rmSync(png);

  return {
    weight: face.weight,
    italic: face.italic,
    atlas: `${family.id}/${name}.webp`,
    layout: `${family.id}/${name}.json`,
    metrics: readFontMetrics(readFileSync(fontPath)),
  };
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1]?.split(',') ?? []) : null;
  const downloadOnly = args.includes('--download-only');

  const families = only ? FAMILIES.filter((f) => only.has(f.id)) : FAMILIES;
  if (only) {
    const unknown = [...only].filter((id) => !FAMILIES.some((f) => f.id === id));
    if (unknown.length) throw new Error(`unknown font id(s): ${unknown.join(', ')}. Known: ${FAMILIES.map((f) => f.id).join(', ')}`);
  }

  console.log('Fetching font sources…');
  const fonts = new Map<FaceSpec, string>();
  const licenses = new Map<FamilySpec, string>();
  for (const family of families) {
    licenses.set(family, await resolveFile(family.licenseFile));
    for (const face of family.faces) fonts.set(face, await resolveFile(face.font));
  }
  if (downloadOnly) return;

  const tool = ensureMsdfAtlasGen();

  const manifestPath = path.join(OUT, 'manifest.json');
  const previous: Manifest | null = only && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const generated = new Map<string, ManifestFamily>(previous?.families.map((f) => [f.id, f]) ?? []);

  for (const family of families) {
    console.log(`${family.wordName} → ${family.substitute}`);
    const faces: ManifestFace[] = [];
    for (const face of family.faces) {
      console.log(`  ${faceName(face)}`);
      faces.push(await generateFace(tool, family, face, fonts.get(face)!));
    }
    copyFileSync(licenses.get(family)!, path.join(OUT, family.id, 'LICENSE.txt'));
    // Files are overwritten in place (a running dev server keeps serving the folder); remove
    // anything left over from an earlier configuration.
    const produced = new Set(['LICENSE.txt', 'coverage.json', ...faces.flatMap((f) => [path.basename(f.atlas), path.basename(f.layout)])]);
    for (const file of readdirSync(path.join(OUT, family.id))) {
      if (!produced.has(file)) rmSync(path.join(OUT, family.id, file));
    }
    generated.set(family.id, {
      id: family.id,
      wordName: family.wordName,
      substitute: family.substitute,
      license: family.license,
      licenseFile: `${family.id}/LICENSE.txt`,
      aliases: family.aliases ?? {},
      faces,
      ...(family.cjk ? { cjk: { ...family.cjk, coverage: writeCoverage(family.id, faces[0].layout) } } : {}),
    });
  }

  const manifest: Manifest = {
    atlas: { ...ATLAS, generator: `msdf-atlas-gen@${MSDF_ATLAS_GEN.commit}` },
    // Keep manifest order stable (sources.ts order) regardless of --only.
    families: FAMILIES.map((f) => generated.get(f.id)).filter((f): f is ManifestFamily => !!f),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, manifestPath)}`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
