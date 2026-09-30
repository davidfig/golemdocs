// Help ▸ What’s New: the changelog, one section per version. Loaded on first use (see Chrome.showChangelog),
// so the text and this code stay out of the main bundle.

import { t } from '../i18n/index.ts';
import changelog from '../../../CHANGELOG.md?raw';
import { parseChangelog } from './changelogParse.ts';
import { h } from './dom.ts';
import { showDialog } from './popup.ts';

export function showChangelog(onClose: () => void): void {
  const body = h('div', { class: 'wm-scroll wm-changelog' });
  const releases = parseChangelog(changelog).filter((r) => r.groups.some((g) => g.entries.length));
  for (const release of releases) {
    const bare = /^(next|unreleased)$/i.test(release.version);
    const when = release.next ? t('chrome.changelog.unreleased') : release.date;
    const heading = h('h3', { text: bare ? (when ?? '') : release.version });
    if (when && !bare) heading.append(h('span', { class: 'wm-changelog-date', text: when }));
    const section = h('section', {}, heading);
    for (const group of release.groups) {
      if (group.title) section.append(h('h4', { text: group.title }));
      section.append(h('ul', {}, ...group.entries.map((entry) => h('li', { text: entry }))));
    }
    body.append(section);
  }
  if (!releases.length) body.append(h('p', { text: t('chrome.changelog.empty') }));
  showDialog(t('chrome.changelog.title'), body, onClose);
}
