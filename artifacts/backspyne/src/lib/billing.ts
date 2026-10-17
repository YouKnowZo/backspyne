/** Billing responses have one consumable body; keep the server's actionable error. */
export async function billingRequest<T = Record<string, unknown>>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `Billing request failed (${response.status}).`);
  }
  if (!payload || typeof payload !== 'object') throw new Error('The billing API returned an invalid response.');
  return payload as T;
}
