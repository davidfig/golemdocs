// Sign-in state for the client (server/src/authRoutes.ts). The session is an HttpOnly cookie, so
// nothing here handles a token: the page just asks who is signed in and links to the sign-in routes.

export interface AuthProvider {
  id: string;
  name: string;
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
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

export async function currentUser(): Promise<User | null> {
  const response = await fetch('/api/auth/me');
  if (!response.ok) return null;
  return ((await response.json()) as { user: User | null }).user;
}

/** Where to send the browser to sign in; it comes back to `returnTo` (a path on this site). */
export function signInUrl(providerId: string, returnTo = location.pathname + location.search): string {
  return `/api/auth/start/${encodeURIComponent(providerId)}?return=${encodeURIComponent(returnTo)}`;
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

/** Why the last sign-in attempt failed, if the server sent us back with `?auth_error=`. */
export function takeAuthError(): string | null {
  const params = new URLSearchParams(location.search);
  const reason = params.get('auth_error');
  if (!reason) return null;
  params.delete('auth_error');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
  return reason === 'denied' ? 'Sign-in was cancelled.' : 'Sign-in failed. Please try again.';
}
