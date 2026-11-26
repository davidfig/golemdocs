// Page view's chunk (docs/html-pages.md): everything main.ts loads the first time an HTML page is shown as a page, as one module so
// it builds as one chunk. Only ever `import()`ed.

export { PageController } from './controller.ts';
export { askReads, confirmLink, confirmMine } from './dialogs.ts';
