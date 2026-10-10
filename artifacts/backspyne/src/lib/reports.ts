// Links into the client-facing assessment document.
//
// The report is rendered by the server from the operator's own stored observations, so the
// console never assembles a document itself: it hands the server the two display labels the
// operator chose and opens what comes back. Both labels are display-only; the server
// authorizes the request against the signed-in session, never against these values.

/** The signed-in operator's own copy of the assessment document. */
export function clientReportUrl(site: string, operatorName: string): string {
  const params = new URLSearchParams({ site: site.slice(0, 80), for: operatorName.slice(0, 80) });
  return `/api/report/assessment?${params.toString()}`;
}

export interface ReportShareLink {
  url: string;
  expiresAt: string;
  days: number;
}

/**
 * Asks the server for a link a client can open without an account. The server signs the
 * account and an expiry into the link, so what comes back is a complete URL rather than a
 * token this side has to assemble.
 */
export async function createReportShareLink(site: string, operatorName: string): Promise<ReportShareLink> {
  const response = await fetch('/api/report/assessment/share', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: site.slice(0, 80), for: operatorName.slice(0, 80) }),
  });
  const payload = await response.json().catch(() => null) as { url?: unknown; expiresAt?: unknown; days?: unknown; error?: unknown } | null;
  if (!response.ok || typeof payload?.url !== 'string') {
    const message = typeof payload?.error === 'string' && payload.error ? payload.error : `The share link could not be created (${response.status}).`;
    throw new Error(message);
  }
  return {
    url: new URL(payload.url, window.location.origin).toString(),
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : '',
    days: typeof payload.days === 'number' ? payload.days : 7,
  };
}
