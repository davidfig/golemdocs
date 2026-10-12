// Interface settings kept in the account, so a person finds the app as they left it on another computer.
// The settings are the browser-storage keys below; the layout of the toolbars, the sizes and positions
// of panels and icons, and what each document remembers (zoom, scroll) stay on the device, as screens differ.
// A phone has settings of its own: a profile ('mobile') kept apart from a computer's ('desktop').
//
// On load the account's settings are compared with this browser's (`planSync`): what the account has
// that this browser hasn't changed since the last sync is applied (and the page reloads once, as most
// settings are read at startup); what this browser changed is sent. Later changes are sent as they happen.

export type Profile = 'desktop' | 'mobile';

/** The browser-storage keys that are kept in the account. */
export const SYNCED_KEYS: readonly string[] = [
  'golem.theme', // color scheme
  'golem.appearance', // light, dark or automatic
  'golem.darkPages',
  'wm.locale', // language
  'wm-shortcuts', // custom keyboard shortcuts
  'word.autoFormat',
  'word.replacements.v1', // the user's own replacement list for autocorrect
  'word.autoCorrect', // smart quotes, dashes and the other autocorrect rules turned off
  'word.spelling.asYouType',
  'word.spelling.grammar',
  'word.userDictionary.v1',
  'word.spelling.ignored.v1', // what is ignored in each document, by the document's account id
  'golem.newKinds', // the types File › New offers, last used first
  'golem.newVersion.off', // "Don't show again" on the new-version note
  'word.viewMode',
  'word.formattingMarks',
  'word.ruler',
  'word.footer', // status bar
  'word.fullScreenMenus', // Tools › Options: keep the menu bar in full screen
  'word.toolbarsShown', // View › Toolbars › Show Toolbars
  'wm.largeWrap',
  'vector.selectAfterPencil', // drawing options (Tools › Options)
  'vector.returnToSelect',
  'vector.pencilSmoothing',
  'vector.penPressure',
  'vector.nudgeSize', // the Nudge brush (its options strip)
  'vector.nudgeStrength',
];

/** A phone or tablet (a touch screen with nothing to hover with), whose settings are its own. */
export function settingsProfile(): Profile {
  try {
    return matchMedia('(pointer: coarse) and (hover: none)').matches ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}

/** A setting's text, or null when it is not set (so, at its default). */
export type Values = Record<string, string | null>;

export interface Plan {
  /** What to take from the account into this browser. */
  apply: Values;
  /** What to send to the account. */
  push: Values;
}

/**
 * What to do about each setting. `local` is this browser's values, `base` what both agreed on at the
 * last sync (null: never synced), and `cloud` what the account has (a key it lacks was never set).
 * Never synced, the account wins where it has a value (a new computer looks like the others), and
 * this browser's own values go up where it has none. After that, a setting changed here goes up and
 * one changed only in the account comes down.
 */
export function planSync(local: Values, base: Values | null, cloud: Values): Plan {
  const apply: Values = {};
  const push: Values = {};
  for (const key of SYNCED_KEYS) {
    const mine = local[key] ?? null;
    const inCloud = key in cloud;
    const theirs = cloud[key] ?? null;
    if (base === null || !(key in base)) {
      if (inCloud) {
        if (theirs !== mine) apply[key] = theirs;
      } else if (mine !== null) push[key] = mine;
    } else if (mine !== (base[key] ?? null)) {
      if (!inCloud || theirs !== mine) push[key] = mine;
    } else if (inCloud && theirs !== mine) {
      apply[key] = theirs;
    }
  }
  return { apply, push };
}

/** What changed here since `base`, to send. */
export function changedSince(local: Values, base: Values): Values {
  const changed: Values = {};
  for (const key of SYNCED_KEYS) if ((local[key] ?? null) !== (base[key] ?? null)) changed[key] = local[key] ?? null;
  return changed;
}

const META_KEY = 'golem.settingsSync';

interface Meta {
  user: string;
  profile: Profile;
  base: Values;
}

function readLocal(): Values {
  const values: Values = {};
  for (const key of SYNCED_KEYS) {
    try {
      values[key] = localStorage.getItem(key);
    } catch {
      values[key] = null;
    }
  }
  return values;
}

function readMeta(user: string, profile: Profile): Values | null {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) ?? 'null') as Meta | null;
    return meta && meta.user === user && meta.profile === profile && meta.base && typeof meta.base === 'object' ? meta.base : null;
  } catch {
    return null;
  }
}

function writeMeta(user: string, profile: Profile, base: Values): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({ user, profile, base } satisfies Meta));
  } catch {
    // Storage blocked: the next load starts from the account again.
  }
}

/** Where the settings go and come from (the account's server). */
export interface SettingsApi {
  get(profile: Profile): Promise<Record<string, { value: string | null }>>;
  put(profile: Profile, values: Values): Promise<void>;
}

export const serverSettings: SettingsApi = {
  async get(profile) {
    const response = await fetch(`/api/preferences?profile=${profile}`);
    if (!response.ok) throw new Error(String(response.status));
    return ((await response.json()) as { prefs: Record<string, { value: string | null }> }).prefs;
  },
  async put(profile, values) {
    const keys = Object.keys(values);
    // The server takes a few at a time.
    for (let at = 0; at < keys.length; at += 20) {
      const prefs = Object.fromEntries(keys.slice(at, at + 20).map((k) => [k, values[k]!]));
      const response = await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile, prefs }), keepalive: true });
      if (!response.ok) throw new Error(String(response.status));
    }
  },
};

const WATCH_MS = 2000;

/**
 * Brings this browser and the account's settings together for `user`, then keeps sending what changes here.
 * When settings were taken from the account the page has to reload to show them: `reload` does that, once its
 * work is saved.
 */
export async function syncSettings(user: string, options: { api?: SettingsApi; profile?: Profile; reload: () => void | Promise<void>; watchChanges?: boolean }): Promise<void> {
  const api = options.api ?? serverSettings;
  const profile = options.profile ?? settingsProfile();
  let base: Values;
  try {
    const cloud: Values = {};
    for (const [key, entry] of Object.entries(await api.get(profile))) cloud[key] = entry.value;
    const local = readLocal();
    const plan = planSync(local, readMeta(user, profile), cloud);
    if (Object.keys(plan.push).length) await api.put(profile, plan.push);
    base = { ...local, ...plan.push };
    let applied = false;
    for (const [key, value] of Object.entries(plan.apply)) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        base[key] = value;
        applied = true;
      } catch {
        // Storage blocked: nothing can be kept here.
      }
    }
    writeMeta(user, profile, base);
    if (applied) {
      await options.reload();
      return;
    }
  } catch {
    return; // Offline or the account is unreachable: this browser's settings stand until the next load.
  }
  if (options.watchChanges ?? true) watch(user, profile, base, api);
}

interface Watch {
  user: string;
  profile: Profile;
  base: Values;
  api: SettingsApi;
  sending: boolean;
}

let watched: Watch | null = null;
let watching: number | undefined;
let listening = false;

/** Stops sending (signed out, or no longer syncing). */
export function stopSettingsSync(): void {
  window.clearInterval(watching);
  watched = null;
}

async function send(watch: Watch): Promise<void> {
  if (watch.sending) return;
  const changed = changedSince(readLocal(), watch.base);
  if (!Object.keys(changed).length) return;
  watch.sending = true;
  try {
    await watch.api.put(watch.profile, changed);
    watch.base = { ...watch.base, ...changed };
    writeMeta(watch.user, watch.profile, watch.base);
  } catch {
    // Tried again at the next check.
  } finally {
    watch.sending = false;
  }
}

/** Sends a setting changed here, soon after, and as the page is left. */
function watch(user: string, profile: Profile, base: Values, api: SettingsApi): void {
  stopSettingsSync();
  const mine: Watch = { user, profile, base, api, sending: false };
  watched = mine;
  watching = window.setInterval(() => void send(mine), WATCH_MS);
  if (listening) return;
  listening = true;
  const leaving = (): void => {
    if (watched) void send(watched);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leaving();
  });
  window.addEventListener('pagehide', leaving);
}
