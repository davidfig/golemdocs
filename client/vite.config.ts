import { createReadStream, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { welcomeContent } from './seo';

const CORPUS_DIR = path.resolve(import.meta.dirname, '../.cache/docx-corpus');
const CORPUS_URL = '/__corpus/';

/**
 * The round-trip test corpus (pnpm --filter @word/docx corpus), served by the dev server only:
 * GET /__corpus/ lists the files, /__corpus/<name> serves one. Builds never reference it.
 */
function docxCorpus(): Plugin {
  return {
    name: 'docx-corpus',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(CORPUS_URL, (req, res) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
        if (!name) {
          const files = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((f) => /\.docx$/i.test(f)) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files.sort((a, b) => a.localeCompare(b))));
          return;
        }
        const file = path.join(CORPUS_DIR, path.basename(name));
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [docxCorpus(), welcomeContent()],
  // The layout worker is an ES module (it imports the docx and layout packages).
  worker: { format: 'es' },
  server: {
    port: 5173,
    // Forward API calls to the server package during development. The Worker sees its own address
    // (:3001), so it's told the one the browser is on, for origin checks and sign-in redirects.
    proxy: {
      '/api': { target: 'http://localhost:3001', ws: true, headers: { 'x-dev-origin': 'http://localhost:5173' } },
    },
  },
});
