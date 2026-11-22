// The viewer page (viewer.html): the embeddable viewer on a page of its own, for a host to put in a frame (a sandboxed one: it needs
// only `allow-scripts`). The host sends it a file with postMessage and hears back when it is open, when it can't be, and when a link
// in it is clicked: see ./host.ts, ./protocol.ts and docs/architecture/viewer.md.

import { hostViewer } from './host.ts';

hostViewer();
