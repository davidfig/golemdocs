// Small WebCrypto helpers for the auth flows (no dependencies).

export function base64url(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Unguessable URL-safe string from `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PKCE S256 code challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The claims of a JWT. Does not verify a signature; see verifyIdToken for why that's acceptable. */
export function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  return JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!))) as Record<string, unknown>;
}

/** Signs a JWT with ES256 from a PKCS#8 PEM private key (an Apple .p8 file). */
export async function signJwtES256(header: object, payload: object, pem: string): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/\\n/g, '').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  // WebCrypto returns the raw r||s signature that JWS ES256 expects.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}
