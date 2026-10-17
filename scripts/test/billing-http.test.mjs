import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createAdminSession } from '../../artifacts/api-server/src/lib/adminAuth.ts';

const require = createRequire(new URL('../../artifacts/api-server/package.json', import.meta.url));
const { build } = require('esbuild');
const { drizzle } = require('drizzle-orm/pglite');
const express = require('express');
const root = path.resolve(import.meta.dirname, '../..');

// The router, signature verification, SQL transactions and catalog are real. Only the
// external identity provider, PostgreSQL connection and Stripe network are replaced.
test('billing HTTP lifecycle, retry recovery, ownership and portal access', async t => {
  const pg = new PGlite();
  await pg.exec(readFileSync(path.join(root, 'lib/db/backspyne-billing.sql'), 'utf8'));
  globalThis.__billingTestDb = drizzle(pg);
  const directory = mkdtempSync(path.join(tmpdir(), 'backspyne-billing-'));
  const outfile = path.join(directory, 'router.mjs');
  await build({
    entryPoints: [path.join(root, 'artifacts/api-server/src/routes/billing.ts')],
    outfile, bundle: true, platform: 'node', format: 'esm',
    banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' },
    plugins: [{ name: 'isolated-billing-dependencies', setup(build) {
      build.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: 'database', namespace: 'test' }));
      build.onResolve({ filter: /^@clerk\/express$/ }, () => ({ path: 'identity', namespace: 'test' }));
      build.onResolve({ filter: /\/lib\/logger$/ }, () => ({ path: 'logger', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents:
        path === 'database' ? 'export const db=globalThis.__billingTestDb;' :
        path === 'identity' ? 'export function getAuth(req) { return {userId:req.header("x-test-owner") || null}; }' :
        'export const logger={error(){},warn(){}};', loader: 'js' }));
    } }],
  });
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'production', CLERK_SECRET_KEY: 'test-harness', CLERK_PUBLISHABLE_KEY: 'test-harness',
    STRIPE_SECRET_KEY: 'sk_test_harness12345678', STRIPE_WEBHOOK_SECRET: 'whsec_harness',
    STRIPE_PRICE_SOLO: 'price_solo', STRIPE_PRICE_TEAM: 'price_team', STRIPE_PRICE_CONSULTANT: 'price_consultant',
    FRONTEND_ORIGIN: 'https://example.test', BACKSPYNE_ADMIN_OWNER_ID: 'deployment_admin', BACKSPYNE_OWNER_USER_IDS: '',
  });
  const router = (await import(pathToFileURL(outfile).href)).default;
  const app = express();
  app.use(express.json({ verify(req, _res, buffer) { req.rawBody = Buffer.from(buffer); } }));
  app.use('/api', router);
  app.use((error, _req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  let status = 'active';
  let price = 'price_solo';
  let failStripe = false;
  let calls = [];
  let listedSessions = [];
  const subscription = () => ({ id: 'sub_1', status, customer: 'cus_1', current_period_end: 1800000000,
    metadata: { ownerId: 'user_1', planId: 'solo' }, items: { data: [{ price: { id: price } }] } });
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.stripe.com/')) return realFetch(url, init);
    calls.push({ url: String(url), init });
    if (failStripe) return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
    if (String(url).endsWith('/customers')) return Response.json({ id: 'cus_1' });
    if (String(url).includes('/subscriptions?')) return Response.json({ data: [] });
    if (String(url).includes('/checkout/sessions?')) return Response.json({ data: listedSessions });
    if (String(url).endsWith('/subscriptions/sub_1')) return Response.json(subscription());
    if (String(url).includes('/checkout/sessions/cs_test_')) return Response.json({
      id: 'cs_test_return', mode: 'subscription', status: 'complete', client_reference_id: 'user_1',
      metadata: { ownerId: 'user_1' }, subscription: 'sub_1',
    });
    if (String(url).endsWith('/checkout/sessions')) return Response.json({ id: 'cs_test_start', url: 'https://checkout.stripe.com/test-session' });
    if (String(url).endsWith('/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.com/test-portal' });
    throw new Error(`Unexpected Stripe test call: ${url}`);
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await new Promise(resolve => server.close(resolve));
    await pg.close();
    delete globalThis.__billingTestDb;
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async (route, { owner = 'user_1', method = 'GET', body, headers = {} } = {}) => {
    const response = await realFetch(`${origin}/api/billing/${route}`, { method,
      headers: { ...(owner ? { 'x-test-owner': owner } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    return { response, body: await response.json() };
  };
  const webhook = async (id, type = 'customer.subscription.updated', invalid = false) => {
    const body = { id, type, data: { object: type.startsWith('invoice.') ? { subscription: 'sub_1' } : subscription() } };
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', invalid ? 'wrong' : 'whsec_harness').update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
    return request('webhook', { owner: '', method: 'POST', body, headers: { 'Stripe-Signature': `t=${timestamp},v1=${digest}` } });
  };

  assert.equal((await request('catalog', { owner: '' })).response.status, 401);
  assert.equal((await request('sync', { owner: '', method: 'POST', body: {} })).response.status, 401);
  assert.equal((await request('checkout', { method: 'POST', body: { planId: 'solo' }, headers: { Origin: 'https://foreign.test' } })).response.status, 403);
  assert.equal((await request('portal', { method: 'POST', body: {} })).response.status, 400);
  const checkout = await request('checkout', { method: 'POST', body: { planId: 'solo' } });
  assert.equal(checkout.response.status, 200);
  const creation = calls.find(call => call.url.endsWith('/checkout/sessions'));
  assert.match(creation.init.headers['Idempotency-Key'], /^backspyne-checkout-/);
  assert.match(new URLSearchParams(creation.init.body).get('success_url'), /\/user-portal\/plan\?billing=success&session_id=\{CHECKOUT_SESSION_ID\}/);
  listedSessions = [{ id: 'cs_test_start', status: 'open', mode: 'subscription', metadata: { ownerId: 'user_1', planId: 'solo' }, url: 'https://checkout.stripe.com/test-session' }];
  const creationsBefore = calls.filter(call => call.url.endsWith('/checkout/sessions')).length;
  assert.equal((await request('checkout', { method: 'POST', body: { planId: 'solo' } })).body.url, checkout.body.url);
  assert.equal(calls.filter(call => call.url.endsWith('/checkout/sessions')).length, creationsBefore);
  assert.equal((await request('checkout', { method: 'POST', body: { planId: 'team' } })).response.status, 409);
  listedSessions[0].status = 'expired';
  assert.equal((await request('checkout', { method: 'POST', body: { planId: 'solo' } })).response.status, 200);
  const retryCreation = calls.filter(call => call.url.endsWith('/checkout/sessions')).at(-1);
  assert.notEqual(retryCreation.init.headers['Idempotency-Key'], creation.init.headers['Idempotency-Key'], 'Expired checkout does not trap the operator in its old idempotency key');
  listedSessions = [];
  assert.equal((await request('checkout', { method: 'POST', body: { planId: 'owner' } })).response.status, 400);
  assert.equal((await request('portal', { method: 'POST', body: {} })).response.status, 200);
  assert.equal((await webhook('evt_bad', undefined, true)).response.status, 400);
  assert.equal((await pg.query('select * from backspyne_billing_events')).rows.length, 0);

  assert.deepEqual((await webhook('evt_paid')).body, { received: true, applied: true });
  assert.deepEqual((await webhook('evt_paid')).body, { received: true, applied: false, duplicate: true });
  let catalog = await request('catalog');
  assert.equal(catalog.body.currentPlanId, 'solo');
  assert.equal(catalog.body.portalAvailable, true);
  assert.equal(catalog.response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await request('catalog', { owner: 'user_2' })).body.currentPlanId, 'free');
  assert.equal((await request('portal', { owner: 'user_2', method: 'POST', body: {} })).response.status, 400);
  assert.equal((await request('sync', { owner: 'user_2', method: 'POST', body: { sessionId: 'cs_test_return' } })).response.status, 403);
  assert.equal((await request('checkout', { method: 'POST', body: { planId: 'team' } })).response.status, 409);
  assert.equal((await request('portal', { method: 'POST', body: {} })).body.url, 'https://billing.stripe.com/test-portal');

  failStripe = true;
  assert.equal((await webhook('evt_retry')).response.status, 500);
  assert.equal((await pg.query("select * from backspyne_billing_events where id='evt_retry'")).rows.length, 0);
  failStripe = false;
  status = 'past_due';
  assert.equal((await webhook('evt_retry', 'invoice.payment_failed')).body.applied, true);
  catalog = await request('catalog');
  assert.equal(catalog.body.currentPlanId, 'free');
  assert.equal(catalog.body.portalAvailable, true, 'past-due customers can fix their payment method');
  assert.equal(catalog.body.subscriptionExists, true);

  status = 'active'; price = 'price_team';
  assert.equal((await request('sync', { method: 'POST', body: { sessionId: 'cs_test_return' } })).body.currentPlanId, 'team');
  assert.equal((await request('catalog')).body.currentPlanId, 'team');
  status = 'canceled';
  assert.equal((await webhook('evt_cancel')).body.applied, true);
  assert.equal((await request('catalog')).body.currentPlanId, 'free');
  // Replaying an older active snapshot cannot reverse current cancellation.
  assert.equal((await webhook('evt_stale', 'invoice.paid')).body.applied, true);
  assert.equal((await request('catalog')).body.currentPlanId, 'free');

  // The admin-only deployment must not call Clerk getAuth without Clerk middleware.
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_PUBLISHABLE_KEY;
  process.env.BACKSPYNE_ADMIN_EMAIL = 'admin@example.test';
  process.env.BACKSPYNE_ADMIN_SESSION_SECRET = 'test-session-secret-at-least-thirty-two-characters';
  const cookie = createAdminSession('admin@example.test');
  assert.ok(cookie);
  const administrator = await request('catalog', { owner: '', headers: { Cookie: `backspyne_admin=${cookie}` } });
  assert.equal(administrator.response.status, 200);
  assert.equal(administrator.body.currentPlanId, 'owner');
  assert.equal((await request('catalog', { owner: '' })).response.status, 401);
});
