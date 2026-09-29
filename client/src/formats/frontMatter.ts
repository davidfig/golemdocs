/** YAML front matter at the very start of a Markdown file, and the Markdown after it. */
export function splitFrontMatter(source: string): { frontMatter: string | null; body: string } {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontMatter: null, body: source };
  return { frontMatter: match[1], body: text.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '') };
}
