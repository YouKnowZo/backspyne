// Presentation helpers with no state and no network.
//
// These are the phrases the console uses for time and evidence. Keeping them in one place
// means an age is written the same way in the topbar checklist, a device row, and the
// assessment, and a label basis is never described two different ways on one screen.

/** A live string, or the fallback when the relay reported nothing usable. */
export function liveText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** Age of an ISO timestamp in the console's own words. */
export function timeAgo(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

export function ageSecondsFrom(timestamp: number | null): number | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

export function ageText(timestamp: number | null): string {
  const seconds = ageSecondsFrom(timestamp);
  if (seconds === null) return 'unknown';
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function newestTimestamp(values: Array<number | null>): number | null {
  return values.reduce<number | null>((newest, value) => value !== null && (newest === null || value > newest) ? value : newest, null);
}

/** How a vendor label was decided, in words a client could read. */
export function evidenceTier(score: number): string {
  if (score >= 70) return 'strong basis';
  if (score >= 40) return 'moderate basis';
  if (score > 0) return 'weak basis';
  return 'no basis';
}

export function relayUsage(value: string | null): string {
  if (!value) return 'never used';
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? `last used ${timeAgo(value)}` : 'usage unknown';
}

export function relaySlug(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return slug || 'relay';
}

/** Plan prices are quoted in US dollars everywhere the catalog is shown. */
export function usd(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
}

export function isMobileProfile(): boolean {
  return typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.matchMedia('(max-width: 700px)').matches);
}
