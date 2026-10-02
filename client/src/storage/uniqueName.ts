// Names that don't collide: " (2)", " (3)"… before the extension. Shared by Download All and Import ZIP.

/**
 * `name`, or the first of "base (2).ext", "base (3).ext"… whose lowercase form isn't in `taken`
 * (`prefix` is what is put before it in `taken`, such as a folder path). The one chosen is added.
 */
export function uniqueName(name: string, taken: Set<string>, prefix = ''): string {
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let unique = name;
  for (let n = 2; taken.has((prefix + unique).toLowerCase()); n++) unique = `${base} (${n})${ext}`;
  taken.add((prefix + unique).toLowerCase());
  return unique;
}
