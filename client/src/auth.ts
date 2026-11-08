// Sign-in state for the client (server/src/authRoutes.ts). The session is an HttpOnly cookie, so
// nothing here handles a token: the page just asks who is signed in and links to the sign-in routes.
import { t } from './i18n/index.ts';

export interface AuthProvider {
  id: string;
  name: string;
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  /** Their profile picture (an https URL), if the sign-in provider gave one. */
  picture?: string | null;
  /** Set by the server for admins, who get the Cloudflare billing panel. */
  isAdmin?: boolean;
}

/** iPhone, iPad (which reports itself as a Mac) and Mac. */
export function isAppleDevice(): boolean {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(navigator.userAgent);
}

/** The providers the server has configured; "Sign in with Apple" is offered only on Apple devices. */
export async function availableProviders(): Promise<AuthProvider[]> {
  const response = await fetch('/api/auth/providers');
  if (!response.ok) return [];
  const providers = (await response.json()) as AuthProvider[];
  return providers.filter((p) => p.id !== 'apple' || isAppleDevice());
}

const REMEMBERED_KEY = 'golem.account';

/** The account last seen signed in here, so that offline the app still shows that account's documents. */
export function remembered(): User | null {
  try {
    return JSON.parse(localStorage.getItem(REMEMBERED_KEY) ?? 'null') as User | null;
  } catch {
    return null;
  }
}

function remember(user: User | null): void {
  try {
    if (user) localStorage.setItem(REMEMBERED_KEY, JSON.stringify(user));
    else localStorage.removeItem(REMEMBERED_KEY);
  } catch {
    // storage blocked: offline, the app will just look signed out
  }
}

const LAPSED_KEY = 'golem.account.lapsed';

/**
 * The account whose sign-in ran out here without anyone signing out, so that the page can say why its documents
 * are out of view. It lasts over reloads, until someone signs in or signs out or the note about it is closed.
 */
export function lapsedAccount(): User | null {
  try {
    return JSON.parse(localStorage.getItem(LAPSED_KEY) ?? 'null') as User | null;
  } catch {
    return null;
  }
}

function setLapsed(user: User | null): void {
  try {
    if (user) localStorage.setItem(LAPSED_KEY, JSON.stringify(user));
    else localStorage.removeItem(LAPSED_KEY);
  } catch {
    // storage blocked: the note shows for this visit at most
  }
}

/** The person has read the note about their lapsed sign-in. */
export function forgetLapsedAccount(): void {
  setLapsed(null);
}

/** Who is signed in. When the server can't be asked (offline), whoever was last time. */
export async function currentUser(): Promise<User | null> {
  let response: Response;
  try {
    response = await fetch('/api/auth/me');
  } catch {
    return remembered();
  }
  if (response.status >= 500) return remembered();
  let user: User | null = null;
  if (response.ok) {
    try {
      user = ((await response.json()) as { user: User | null }).user ?? null;
    } catch {
      // Not the server's answer (a captive portal's page, say): as good as offline.
      return remembered();
    }
  }
  // Signing out forgets the account first, so one still remembered here has lapsed.
  if (user) setLapsed(null);
  else if (remembered()) setLapsed(remembered());
  remember(user);
  return user;
}

/** Where to send the browser to sign in; it comes back to `returnTo` (a path on this site). */
export function signInUrl(providerId: string, returnTo = location.pathname + location.search): string {
  return `/api/auth/start/${encodeURIComponent(providerId)}?return=${encodeURIComponent(returnTo)}`;
}

/** Ends the session. Fails (throws) when the server can't be reached, and then nothing changes. */
export async function signOut(): Promise<void> {
  const response = await fetch('/api/auth/logout', { method: 'POST' });
  if (!response.ok) throw new Error(t('app.signOutRequestFailed', { status: response.status }));
  remember(null);
  setLapsed(null);
}

/** Why the last sign-in attempt failed, if the server sent us back with `?auth_error=`. */
export function takeAuthError(): string | null {
  const params = new URLSearchParams(location.search);
  const reason = params.get('auth_error');
  if (!reason) return null;
  params.delete('auth_error');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
  return reason === 'denied' ? t('app.authCancelled') : reason === 'not-allowed' ? t('app.authNotAllowed') : t('app.authFailed');
}
