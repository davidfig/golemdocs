// Which code files the text editor colors, and as what (docs/text-files.md, *Syntax colors*). Small and always loaded: the editor
// asks it when a file opens, and only a file it names fetches the coloring chunk (colorize.ts) and that language's grammar.

/** A grammar the coloring chunk has (each a Lezer parser, some with a dialect). */
export type SyntaxId = 'html' | 'css' | 'scss' | 'sass' | 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'json' | 'yaml' | 'xml' | 'markdown' | 'python' | 'go' | 'java' | 'rust' | 'cpp' | 'php';

/** Files larger than this are shown uncolored: the text editor also opens 50 MB logs, and a parse of all of it would stall typing. */
export const MAX_SYNTAX_BYTES = 2 * 1024 * 1024;

const BY_EXTENSION: Record<string, SyntaxId> = {
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'scss',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  geojson: 'json',
  ipynb: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  rss: 'xml',
  atom: 'xml',
  plist: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyw: 'python',
  go: 'go',
  java: 'java',
  rs: 'rust',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  php: 'php',
  phtml: 'php',
};

/** The grammar a file is colored with, by its name; null for a file shown plain (a log, a language with no grammar here). */
export function syntaxOf(name: string): SyntaxId | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? (BY_EXTENSION[extension] ?? null) : null;
}
