// The paid sync subscription, sold through Polar (server/src/subscriptions.ts). The page only asks
// the server for where to send the user: to Polar's checkout to pay, or to its portal to manage it.

export interface Subscription {
  /** Polar's status (`active`, `canceled`, `none`…). */
  status: string;
  /** Whether the user has sync right now. */
  active: boolean;
  /** When the paid period runs out (ms since the epoch), if there is a subscription. */
  currentPeriodEnd: number | null;
  /** Canceled, but paid up until `currentPeriodEnd`. */
  cancelAtPeriodEnd: boolean;
  /** Whether the account may keep documents in the cloud: subscribed, an admin, or not required yet. */
  sync?: boolean;
}

/** The signed-in user's subscription; null when it can't be asked (signed out, offline, not set up). */
export async function fetchSubscription(): Promise<Subscription | null> {
  try {
    const response = await fetch('/api/subscription');
    return response.ok ? ((await response.json()) as Subscription) : null;
  } catch {
    return null;
  }
}

async function addressFrom(path: string): Promise<string> {
  const response = await fetch(path, { method: 'POST' });
  const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!response.ok || !body?.url) throw new SubscriptionError(response.status, body?.error ?? `status ${response.status}`);
  return body.url;
}

export class SubscriptionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Polar's checkout page for the monthly subscription. Refused (409) when they already have it. */
export const checkoutUrl = (): Promise<string> => addressFrom('/api/checkout');

/** Polar's customer portal, where they change their card, see invoices or cancel. */
export const portalUrl = (): Promise<string> => addressFrom('/api/portal');

/**
 * Waits for a payment to show up: Polar tells the server by webhook a moment after checkout, so
 * the page asks a few times. Resolves with the subscription once it is active, else null.
 */
export async function waitForSubscription(options: { attempts?: number; delayMs?: number } = {}): Promise<Subscription | null> {
  const { attempts = 20, delayMs = 2000 } = options;
  for (let i = 0; i < attempts; i++) {
    const subscription = await fetchSubscription();
    if (subscription?.active) return subscription;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}
