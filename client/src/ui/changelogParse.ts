// Reads CHANGELOG.md (at the repository root): `## Next` or `## <version> - <date>` headings, each with
// `### Group` sections of `- entry` lines. Pure text, so it is tested without a browser.

export interface ChangelogGroup {
  title: string;
  entries: string[];
}

export interface ChangelogRelease {
  /** The version (or 'Next' when none is set yet). */
  version: string;
  /** The release date, or 'Unreleased'. */
  date?: string;
  /** True for the changes not yet released. */
  next: boolean;
  groups: ChangelogGroup[];
}

export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let group: ChangelogGroup | null = null;
  let last = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading && !line.startsWith('###')) {
      const [version = '', date] = heading[1]!.split(/\s+[-–—]\s+/, 2);
      release = { version: version.replace(/^\[|\]$/g, '').trim(), date: date?.trim(), next: /^(next|unreleased)$/i.test(version.trim()) || /^(next|unreleased)$/i.test(date?.trim() ?? ''), groups: [] };
      releases.push(release);
      group = null;
      continue;
    }
    if (!release) continue;
    const title = /^###\s+(.+)$/.exec(line);
    if (title) {
      group = { title: title[1]!.trim(), entries: [] };
      release.groups.push(group);
      last = -1;
      continue;
    }
    const entry = /^[-*]\s+(.+)$/.exec(line);
    if (entry) {
      // Entries listed before any group go in an untitled one.
      if (!group) release.groups.push((group = { title: '', entries: [] }));
      last = group.entries.push(entry[1]!.trim()) - 1;
    } else if (group && last >= 0 && /^\s+\S/.test(line)) {
      group.entries[last] += ` ${line.trim()}`;
    } else {
      last = -1;
    }
  }
  return releases;
}
