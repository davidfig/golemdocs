// The live worker's entry file: it only starts liveWorker.ts, which the build keeps in a chunk of its own (the same reason as
// the layout worker's: see `worker` in vite.config.ts).
import './liveWorker.ts';
