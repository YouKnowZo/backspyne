import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { applyBillingEvent } from '../../artifacts/api-server/src/lib/billing/store.ts';
import { currentSubscriptionUpdate, checkoutIdempotencyKey, blocksNewSubscription, stripeSubscriptionIdFromEvent, subscriptionUpdateFromEvent } from '../../artifacts/api-server/src/lib/billing/stripe.ts';

const require = createRequire(new URL('../../artifacts/api-server/package.json', import.meta.url));
const { drizzle } = require('drizzle-orm/pglite');
const CONFIG = { secretKey: 'sk_test_fake12345678', webhookSecret: 'whsec_test', origin: 'https://example.test', priceIds: { solo: 'price_solo', team: 'price_team' } };
const update = (overrides = {}) => ({ ownerId: 'user_1', planId: 'solo', status: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', currentPeriodEnd: new Date('2027-01-01'), unattributed: false, ...overrides });

async function fixture(t) {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../lib/db/backspyne-billing.sql', import.meta.url), 'utf8'));
  t.after(() => pg.close());
  return { pg, db: drizzle(pg), event: { id: 'evt_1', type: 'customer.subscription.updated' } };
}

test('dedupe and subscription update commit together; the same event remains retryable after an SQL failure', async t => {
  const { pg, db, event } = await fixture(t);
  await pg.exec("alter table backspyne_subscriptions add constraint reject_test_status check (status <> 'fail')");
  await assert.rejects(applyBillingEvent(db, event, 'user_1', async () => update({ status: 'fail' })));
  assert.equal((await pg.query('select * from backspyne_billing_events')).rows.length, 0);
  assert.equal((await pg.query('select * from backspyne_subscriptions')).rows.length, 0);
  assert.deepEqual(await applyBillingEvent(db, event, 'user_1', async () => update()), { applied: true });
  assert.equal((await pg.query('select * from backspyne_billing_events')).rows.length, 1);
  assert.deepEqual(await applyBillingEvent(db, event, 'user_1', async () => { throw new Error('duplicate must not call Stripe'); }), { applied: false, duplicate: true });
});

test('a Stripe outage or owner mismatch leaves no dedupe receipt or entitlement', async t => {
  const { pg, db, event } = await fixture(t);
  await assert.rejects(applyBillingEvent(db, event, 'user_1', async () => { throw new Error('Stripe unavailable'); }));
  await assert.rejects(applyBillingEvent(db, event, 'user_1', async () => update({ ownerId: 'user_2' })), /attribution/);
  assert.equal((await pg.query('select * from backspyne_billing_events')).rows.length, 0);
});

test('simultaneous duplicate deliveries produce one event and one subscription', async t => {
  const { pg, db, event } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => applyBillingEvent(db, event, 'user_1', async () => update())));
  assert.equal(results.filter(r => r.applied).length, 1);
  assert.equal(results.filter(r => r.duplicate).length, 4);
  assert.equal((await pg.query('select * from backspyne_subscriptions')).rows.length, 1);
});

test('a stale event reconciles current Stripe state instead of resurrecting canceled access', async t => {
  const { pg, db } = await fixture(t);
  let currentStatus = 'active';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ id: 'sub_1', status: currentStatus, customer: 'cus_1', metadata: { ownerId: 'user_1', planId: 'team' }, items: { data: [{ price: { id: 'price_solo' } }] } });
  await applyBillingEvent(db, { id: 'evt_cancel', type: 'customer.subscription.deleted' }, 'user_1', () => currentSubscriptionUpdate(CONFIG, 'sub_1'));
  currentStatus = 'canceled';
  await applyBillingEvent(db, { id: 'evt_old_active', type: 'customer.subscription.created' }, 'user_1', () => currentSubscriptionUpdate(CONFIG, 'sub_1'));
  const rows = (await pg.query('select * from backspyne_subscriptions')).rows;
  assert.equal(rows[0].status, 'canceled');
  assert.equal(rows[0].plan_id, 'solo', 'actual price overrides stale metadata');
});

test('an old subscription cannot overwrite its replacement and two operators remain isolated', async t => {
  const { pg, db } = await fixture(t);
  await applyBillingEvent(db, { id: 'evt_new', type: 'customer.subscription.updated' }, 'user_1', async () => update({ stripeSubscriptionId: 'sub_new' }));
  assert.deepEqual(await applyBillingEvent(db, { id: 'evt_old', type: 'customer.subscription.deleted' }, 'user_1', async () => update({ status: 'canceled' })), { applied: false });
  await applyBillingEvent(db, { id: 'evt_other', type: 'customer.subscription.updated' }, 'user_2', async () => update({ ownerId: 'user_2', stripeSubscriptionId: 'sub_2', planId: 'team' }));
  const rows = (await pg.query('select owner_id, stripe_subscription_id, plan_id from backspyne_subscriptions order by owner_id')).rows;
  assert.deepEqual(rows, [ { owner_id: 'user_1', stripe_subscription_id: 'sub_new', plan_id: 'solo' }, { owner_id: 'user_2', stripe_subscription_id: 'sub_2', plan_id: 'team' } ]);
});

test('missing payment status never grants paid access; async results are understood', () => {
  const event = type => ({ id: 'evt_x', type, data: { object: { mode: 'subscription', subscription: 'sub_1', metadata: { ownerId: 'user_1', planId: 'solo' } } } });
  assert.equal(subscriptionUpdateFromEvent(event('checkout.session.completed'), CONFIG).status, 'incomplete');
  const succeeded = event('checkout.session.async_payment_succeeded');
  succeeded.data.object.payment_status = 'paid';
  assert.equal(subscriptionUpdateFromEvent(succeeded, CONFIG).status, 'active');
  const failed = event('checkout.session.async_payment_failed');
  failed.data.object.payment_status = 'paid';
  assert.equal(subscriptionUpdateFromEvent(failed, CONFIG).status, 'incomplete');
  assert.equal(stripeSubscriptionIdFromEvent({ id: 'evt', type: 'invoice.paid', data: { object: { subscription: { id: 'sub_1' } } } }), 'sub_1');
  assert.equal(stripeSubscriptionIdFromEvent({ id: 'evt', type: 'invoice.payment_failed', data: { object: { parent: { subscription_details: { subscription: 'sub_2' } } } } }), 'sub_2');
  assert.equal(stripeSubscriptionIdFromEvent({ id: 'evt', type: 'customer.created', data: { object: { id: 'cus_1' } } }), null);
});

test('unknown current prices remove paid access despite paid metadata; newer item periods are supported', () => {
  const result = subscriptionUpdateFromEvent({ id: 'evt', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', metadata: { ownerId: 'user_1', planId: 'team' }, items: { data: [{ price: { id: 'price_unknown' }, current_period_end: 1800000000 }] } } } }, CONFIG);
  assert.equal(result.planId, 'free');
  assert.equal(result.currentPeriodEnd.getTime(), 1800000000000);
});

test('checkout retries are scoped to the operator and ongoing subscriptions block new purchases', () => {
  assert.equal(checkoutIdempotencyKey('user_1', 'new', 10000), checkoutIdempotencyKey('user_1', 'new', 11000));
  assert.notEqual(checkoutIdempotencyKey('user_1', 'new', 10000), checkoutIdempotencyKey('user_2', 'new', 10000));
  assert.notEqual(checkoutIdempotencyKey('user_1', 'sub_1', 10000), checkoutIdempotencyKey('user_1', 'new', 10000));
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']) assert.equal(blocksNewSubscription(status), true);
  for (const status of ['canceled', 'incomplete_expired', 'inactive', undefined]) assert.equal(blocksNewSubscription(status), false);
});
