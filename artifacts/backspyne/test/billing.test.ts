import test from 'node:test';
import assert from 'node:assert/strict';
import { billingRequest } from '../src/lib/billing.ts';

test('billing errors preserve the server message rather than trying to consume the body twice', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ error: 'Use Manage billing to change plans.', code: 'subscription_exists' }, { status: 409 });
  await assert.rejects(billingRequest('/api/billing/checkout', { method: 'POST', body: '{}' }), /Use Manage billing/);
});

test('billing requests authenticate and set JSON headers only for a request body', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(init!); return Response.json({ url: 'https://billing.stripe.com/test' }); };
  assert.deepEqual(await billingRequest('/api/billing/portal', { method: 'POST', body: '{}' }), { url: 'https://billing.stripe.com/test' });
  assert.equal(requests[0].credentials, 'include');
  assert.equal(new Headers(requests[0].headers).get('Content-Type'), 'application/json');
});

test('malformed billing responses fail with an actionable error', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 502 });
  await assert.rejects(billingRequest('/api/billing/portal'), /502/);
  globalThis.fetch = async () => new Response('not JSON');
  await assert.rejects(billingRequest('/api/billing/catalog'), /invalid response/);
});
