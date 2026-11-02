// SPDX-License-Identifier: MIT
// How much one account may keep in the cloud: its documents, its trash and its history (see server/src/storage.ts for how history
// fits into the space the rest leaves). The home page and the welcome documents state this figure, so change them too
// (`client/home/locales/*.json`, `client/src/layout/welcome/*.md`).

/** The most bytes an account may keep: 25 GB. */
export const ACCOUNT_STORAGE_BYTES = 25 * 1024 * 1024 * 1024;

/** `ACCOUNT_STORAGE_BYTES` as people read it, in gigabytes. */
export const ACCOUNT_STORAGE_GB = ACCOUNT_STORAGE_BYTES / (1024 * 1024 * 1024);
