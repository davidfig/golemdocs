// Generates MSDF font atlases for the Word font substitutes listed in sources.ts.
//
//   pnpm fonts                     all families
//   pnpm fonts --only calibri,arial
//   pnpm fonts --download-only     fetch and verify sources, skip atlas generation
//   pnpm fonts --ttf-only          copy the font files next to the atlases and list them in the manifest, leaving
//                                  the atlases as they are (no msdf-atlas-gen needed)
//
// Output (served by the client's Vite dev server at /fonts/):
//   client/public/fonts/manifest.json           Word font name -> faces, atlases and metrics
//   client/public/fonts/<id>/<face>.webp        MTSDF atlas (lossless WebP)
//   client/public/fonts/<id>/<face>.ttf         the font file, for PDFs to embed (not for the CJK pages)
//   client/public/fonts/<id>/<face>.json        glyph layout (msdf-atlas-gen JSON)
//   client/public/fonts/<id>/LICENSE.txt
//   client/public/fonts/<id>/math.json          the MATH table in ems, for the math font only (see writeMathData)
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
import { ARCHIVES, ATLAS, FAMILIES, MATH_RANGES, MSDF_ATLAS_GEN, type FaceSpec, type FamilySpec, type FileRef } from './sources.ts';
import { readFontMetrics, type FontMetrics } from './ttf-metrics.ts';
import { mathGlyphSet, readMathFont, type GlyphConstruction, type MathFontInfo } from './ttf-math.ts';
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
  /** The font file itself (a TrueType font), for embedding in a PDF: fetched only when a PDF uses the face. Not for the CJK pages. */
  font?: string;
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
  page?: { group: string; order: number; coverage: string };
  /** The math font: `data` is the path of its math.json, relative to the manifest. */
  math?: { data: string };
}

interface Manifest {
  atlas: typeof ATLAS & { generator: string };
  families: ManifestFamily[];
}

// ---------------------------------------------------------------------------------------

/** Runs a command. With `quiet`, output is captured and returned (and printed only on failure). */
function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}): string {
  const result = spawnSync(cmd, args, { cwd: opts.cwd, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
 * separate small file, fetched only for documents with text the family's core page lacks, so the manifest
 * every user loads stays small. A page's faces can differ, so it holds the union.
 */
function writeCoverage(id: string, layoutPaths: string[]): string {
  const all = new Set<number>();
  for (const layoutPath of layoutPaths) {
    const layout = JSON.parse(readFileSync(path.join(OUT, layoutPath), 'utf8')) as { glyphs: { unicode?: number }[] };
    for (const g of layout.glyphs) if (g.unicode !== undefined) all.add(g.unicode);
  }
  const cps = [...all].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const cp of cps) {
    const last = ranges[ranges.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else if (!last || cp > last[1]) ranges.push([cp, cp]);
  }
  writeFileSync(path.join(OUT, id, 'coverage.json'), JSON.stringify(ranges.flat()));
  return `${id}/coverage.json`;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Writes math.json, the math font's MATH table in ems with glyphs named by their position in the
 * atlas layout (which is what layout and the renderer index by), and gives the layout's glyphs the
 * `unicode` they map from, so text lookup works as it does for any face. Glyphs no code point
 * reaches (size variants, assembly pieces) simply have none.
 *
 *   constants                MathConstants in ems; scale and raise percentages as fractions
 *   italics, topAccent       position -> em: italic correction, and where an accent sits over the glyph
 *   extended                 positions of stretchy or tall glyphs (accents flatten over them)
 *   vertical, horizontal     position -> { variants: [[position, size], …], assembly?: { italics, parts: [[position, start, end, full, extender], …] } }
 *   script                   position -> [first-level script glyph, second-level script glyph?] (the ssty feature)
 *   alias                    code point -> position, for code points sharing a glyph with a lower one
 */
function writeMathData(font: MathFontInfo, layoutPath: string, outPath: string): void {
  const layout = JSON.parse(readFileSync(layoutPath, 'utf8')) as { glyphs: { index: number; unicode?: number }[] };
  const position = new Map<number, number>(layout.glyphs.map((g, i) => [g.index, i]));
  const em = (units: number) => round(units / font.unitsPerEm);

  const alias: Record<number, number> = {};
  for (const [cp, gid] of [...font.cmap].sort((a, b) => a[0] - b[0])) {
    const at = position.get(gid);
    if (at === undefined || !MATH_RANGES.some(([from, to]) => cp >= from && cp <= to)) continue;
    if (layout.glyphs[at].unicode === undefined) layout.glyphs[at].unicode = cp;
    else alias[cp] = at;
  }
  writeFileSync(layoutPath, JSON.stringify(layout));

  const percent = new Set(['scriptPercentScaleDown', 'scriptScriptPercentScaleDown', 'radicalDegreeBottomRaisePercent']);
  const constants: Record<string, number> = {};
  for (const [name, value] of Object.entries(font.constants)) constants[name] = percent.has(name) ? round(value / 100) : em(value);

  const byGlyph = (map: Map<number, number>) => Object.fromEntries([...map].flatMap(([gid, v]) => (position.has(gid) ? [[position.get(gid)!, em(v)]] : [])));
  const constructions = (map: Map<number, GlyphConstruction>) =>
    Object.fromEntries(
      [...map].flatMap(([gid, c]) => {
        if (!position.has(gid)) return [];
        const at = (g: number) => {
          const p = position.get(g);
          if (p === undefined) throw new Error(`math variant glyph ${g} is not in the atlas`);
          return p;
        };
        return [[position.get(gid)!, {
          variants: c.variants.map((v) => [at(v.glyph), em(v.advance)]),
          ...(c.assembly ? { assembly: { italics: em(c.assembly.italicsCorrection), parts: c.assembly.parts.map((p) => [at(p.glyph), em(p.startConnector), em(p.endConnector), em(p.fullAdvance), p.extender ? 1 : 0]) } } : {}),
        }]];
      }),
    );

  const data = {
    constants,
    minConnectorOverlap: em(font.minConnectorOverlap),
    italics: byGlyph(font.italics),
    topAccent: byGlyph(font.topAccent),
    extended: [...font.extendedShapes].flatMap((g) => (position.has(g) ? [position.get(g)!] : [])),
    vertical: constructions(font.vertical),
    horizontal: constructions(font.horizontal),
    script: Object.fromEntries([...font.script].flatMap(([gid, alts]) => (position.has(gid) && alts.every((a) => position.has(a)) ? [[position.get(gid)!, alts.map((a) => position.get(a)!)]] : []))),
    alias,
  };
  writeFileSync(outPath, JSON.stringify(data));
}

/** Writes the charset of every character charset.txt leaves out (surrogates aside), for an extra page; its path. */
function writeRestCharset(dir: string): string {
  const taken: [number, number][] = [];
  for (const m of readFileSync(CHARSET, 'utf8').matchAll(/\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]|(0x[0-9a-f]+)/gi)) {
    taken.push(m[3] ? [parseInt(m[3], 16), parseInt(m[3], 16)] : [parseInt(m[1], 16), parseInt(m[2], 16)]);
  }
  taken.push([0xd800, 0xdfff]); // surrogates are not characters
  taken.sort((a, b) => a[0] - b[0]);
  const rest: string[] = [];
  let from = 0x20;
  const free = (to: number) => {
    if (to >= from) rest.push(`[0x${from.toString(16)}, 0x${to.toString(16)}]`);
  };
  for (const [a, b] of taken) {
    free(a - 1);
    from = Math.max(from, b + 1);
  }
  free(0x10ffff);
  const file = path.join(dir, 'rest-charset.txt');
  writeFileSync(file, rest.join(',\n') + '\n');
  return file;
}

async function generateFace(tool: string, family: FamilySpec, face: FaceSpec, fontPath: string, embedPath?: string): Promise<ManifestFace> {
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
  // A math font's atlas is picked by glyph id: size variants and assembly pieces have no code point.
  const math = family.math ? readMathFont(readFileSync(fontPath)) : null;
  let charset: string[];
  if (math) {
    const glyphs = path.join(tmp, `${family.id}-glyphs.txt`);
    writeFileSync(glyphs, mathGlyphSet(math, MATH_RANGES).join(', '));
    charset = ['-glyphset', glyphs];
  } else if (family.charset === 'rest') charset = ['-charset', writeRestCharset(tmp)];
  else charset = ['-charset', family.charset ? path.join(HERE, 'charsets', family.charset) : CHARSET];
  const output = run(tool, [
    ...input,
    ...charset,
    '-fontname', `${family.substitute} ${name}`,
    '-type', atlas.type,
    '-size', String(atlas.size),
    '-pxrange', String(atlas.pxrange),
    ...(family.atlas?.dimensions ? ['-dimensions', ...family.atlas.dimensions.map(String)] : []),
    '-yorigin', ATLAS.yOrigin,
    '-imageout', png,
    '-json', path.join(dir, `${name}.json`),
  ], { quiet: true });

  // Characters in charset.txt that the font doesn't have (charset.txt is every code point, so the atlas holds every glyph the font has); the renderer needs a fallback for these.
  const missing = output.match(/^Missing \d+ codepoints?: .*$/m);
  if (missing) console.log(`    ${missing[0].slice(0, 120)}`);

  await pngToWebp(png, path.join(dir, `${name}.webp`));
  rmSync(png);
  if (math) writeMathData(math, path.join(dir, `${name}.json`), path.join(dir, 'math.json'));

  return {
    weight: face.weight,
    italic: face.italic,
    atlas: `${family.id}/${name}.webp`,
    layout: `${family.id}/${name}.json`,
    ...(family.fontsOf ? { font: `${family.fontsOf}/${faceName(face)}.ttf` } : copyFontFile(family, face, embedPath ?? fontPath)),
    metrics: readFontMetrics(readFileSync(fontPath)),
  };
}

/** Copies a face's font file next to its atlas (not the CJK pages': variable fonts of many megabytes); its manifest entry. */
function copyFontFile(family: FamilySpec, face: FaceSpec, fontPath: string): { font?: string } {
  if (family.page || face.variations) return {};
  const name = `${faceName(face)}.ttf`;
  mkdirSync(path.join(OUT, family.id), { recursive: true });
  copyFileSync(fontPath, path.join(OUT, family.id, name));
  return { font: `${family.id}/${name}` };
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1]?.split(',') ?? []) : null;
  const downloadOnly = args.includes('--download-only');

  // Pages have no font file to copy (an extra page shares its family's), so --ttf-only doesn't fetch their sources.
  const wanted = args.includes('--ttf-only') ? FAMILIES.filter((f) => !f.page) : FAMILIES;
  const families = only ? wanted.filter((f) => only.has(f.id)) : wanted;
  if (only) {
    const unknown = [...only].filter((id) => !FAMILIES.some((f) => f.id === id));
    if (unknown.length) throw new Error(`unknown font id(s): ${unknown.join(', ')}. Known: ${FAMILIES.map((f) => f.id).join(', ')}`);
  }

  console.log('Fetching font sources…');
  const fonts = new Map<FaceSpec, string>();
  const embeds = new Map<FaceSpec, string>();
  const licenses = new Map<FamilySpec, string>();
  for (const family of families) {
    licenses.set(family, await resolveFile(family.licenseFile));
    for (const face of family.faces) {
      fonts.set(face, await resolveFile(face.font));
      if (face.embed) embeds.set(face, await resolveFile(face.embed));
    }
  }
  if (downloadOnly) return;

  if (args.includes('--ttf-only')) {
    const file = path.join(OUT, 'manifest.json');
    const manifest: Manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const family of families) {
      const entry = manifest.families.find((f) => f.id === family.id);
      if (!entry) continue;
      for (const face of family.faces) {
        const made = manifest.families.find((f) => f.id === family.id)!.faces.find((f) => f.weight === face.weight && f.italic === face.italic);
        const copied = copyFontFile(family, face, embeds.get(face) ?? fonts.get(face)!);
        if (made && copied.font) made.font = copied.font;
      }
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Font files copied and listed in ${path.relative(ROOT, file)}`);
    return;
  }

  const tool = ensureMsdfAtlasGen();

  const manifestPath = path.join(OUT, 'manifest.json');
  const previous: Manifest | null = only && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const generated = new Map<string, ManifestFamily>(previous?.families.map((f) => [f.id, f]) ?? []);

  for (const family of families) {
    console.log(`${family.wordName} → ${family.substitute}`);
    const faces: ManifestFace[] = [];
    for (const face of family.faces) {
      console.log(`  ${faceName(face)}`);
      faces.push(await generateFace(tool, family, face, fonts.get(face)!, embeds.get(face)));
    }
    copyFileSync(licenses.get(family)!, path.join(OUT, family.id, 'LICENSE.txt'));
    // Files are overwritten in place (a running dev server keeps serving the folder); remove
    // anything left over from an earlier configuration.
    const produced = new Set(['LICENSE.txt', 'coverage.json', 'math.json', ...faces.flatMap((f) => [path.basename(f.atlas), path.basename(f.layout), ...(f.font ? [path.basename(f.font)] : [])])]);
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
      ...(family.page ? { page: { ...family.page, coverage: writeCoverage(family.id, faces.map((f) => f.layout)) } } : {}),
      ...(family.math ? { math: { data: `${family.id}/math.json` } } : {}),
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
