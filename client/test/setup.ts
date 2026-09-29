// Preloaded by `pnpm test`: the app loads its English catalog at startup, so tests that check
// messages need it loaded too.
import { loadLocale } from '../src/i18n/index.ts';

await loadLocale('en');
