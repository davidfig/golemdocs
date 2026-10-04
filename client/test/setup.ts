// Preloaded by `pnpm test`: the app loads its English catalog at startup, so tests that check
// messages need it loaded too.
import { register } from 'node:module';
import { loadLocale } from '../src/i18n/index.ts';

// Modules of the UI import their stylesheets (`import './thing.css'`); a test that loads one has no use for the CSS, so it is an empty module.
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function load(url, context, next) { if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }; return next(url, context); }`),
);

await loadLocale('en');
