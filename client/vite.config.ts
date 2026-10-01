import { createReadStream, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { welcomeContent } from './seo';

const CORPUS_DIR = path.resolve(import.meta.dirname, '../.cache/docx-corpus');
const CORPUS_URL = '/__corpus/';

/**
 * The round-trip test corpus (pnpm --filter @golemdocs/docx corpus), served by the dev server only:
 * GET /__corpus/ lists the files, /__corpus/<name> serves one. Builds never reference it.
 */
function docxCorpus(): Plugin {
  return {
    name: 'docx-corpus',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(CORPUS_URL, (req, res) => {
        let name: string;
        try {
          name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
        } catch {
          res.statusCode = 400; // a malformed escape would otherwise throw out of the middleware
          res.end();
          return;
        }
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

// The end-to-end tests run their own client and server on other ports (see playwright.config.ts).
const CLIENT_PORT = Number(process.env.WORD_CLIENT_PORT ?? 5173);
const API_PORT = Number(process.env.WORD_API_PORT ?? 3001);

export default defineConfig({
  plugins: [docxCorpus(), welcomeContent()],
  // The layout worker is an ES module (it imports the docx and layout packages).
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // The lazily loaded chunks (formats, dictionaries) import the code they share with the
        // worker. Left alone, that shared code stays in the worker's entry file, so those chunks
        // import the entry. Safari runs a worker's entry script again when it is imported, which
        // starts a second copy of the worker with no open document and takes over its messages.
        // The worker's code is kept in its own chunk, so the entry (layoutWorkerEntry.ts) is a stub
        // that nothing imports.
        manualChunks: (id) => (/[\\/]src[\\/]layout[\\/]layoutWorker\.ts$/.test(id) ? 'layoutCore' : undefined),
      },
    },
  },
  server: {
    port: CLIENT_PORT,
    // Forward API calls to the server package during development. The Worker sees its own address
    // (:3001), so it's told the one the browser is on, for origin checks and sign-in redirects.
    proxy: {
      // changeOrigin sends `Host: localhost:<API_PORT>`. Otherwise wrangler dev, which has the production
      // route configured, rewrites the browser's host wherever it appears in the headers, x-dev-origin
      // included, and the Worker then builds return addresses (checkout, sign-in) for golemdocs.com.
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true, ws: true, headers: { 'x-dev-origin': `http://localhost:${CLIENT_PORT}` } },
    },
  },
});
