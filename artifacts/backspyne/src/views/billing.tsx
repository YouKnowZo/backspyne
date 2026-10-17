// Plan and billing.
//
// The catalog is the server's: whether a plan can be bought on this deployment, what each
// plan entitles an operator to, and which plan this account is on. The view renders that
// truth — including the honest case where no payment provider is configured yet — and never
// infers a purchase from a redirect.

import { useEffect, useState } from 'react';
import { AlertCircle, Check, Wrench, RefreshCw, ArrowRight } from 'lucide-react';

import { usd } from '../lib/format';
import type { BillingCatalog, BillingEntitlements } from '../lib/types';
import { billingRequest } from '../lib/billing';

const referenceTierOutline: Array<{ name: string; summary: string }> = [
  { name: 'Free', summary: '1 authorized relay · 7-day history · no CSV ledger export · no CSI research panels' },
  { name: 'Solo', summary: '1 authorized relay · 30-day history · CSV ledger export · no CSI research panels' },
  { name: 'Team', summary: '5 authorized relays · 90-day history · CSV ledger export · CSI research panels' },
  { name: 'Consultant', summary: '25 authorized relays · 365-day history · CSV ledger export · CSI research panels' },
];

function entitlementRows(entitlements: BillingEntitlements): string[] {
  return [
    // Owner access is described by what it is, not by printing the enforcement ceiling the
    // server still keeps underneath it.
    entitlements.unlimited ? 'Unlimited authorized relays' : `${entitlements.maxRelays} authorized relay${entitlements.maxRelays === 1 ? '' : 's'}`,
    entitlements.unlimited ? 'Full observation history' : `${entitlements.historyDays}-day observation history`,
    entitlements.reportExport ? 'CSV ledger export' : 'CSV ledger export not included',
    entitlements.csiResearch ? 'Experimental CSI research panels' : 'Experimental CSI research not included',
  ];
}

export function Billing() {
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [pendingPortal, setPendingPortal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [reload, setReload] = useState(0);
  const [recoverable, setRecoverable] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams(window.location.search);
    const returned = params.get('billing');
    const sessionId = returned === 'success' ? params.get('session_id') : null;
    const load = async (attempt = 0) => {
      try {
        if (returned === 'success' || returned === 'portal' || reload > 0) {
          setConfirmation('Checking the subscription with the payment provider…');
          await billingRequest('/api/billing/sync', { method: 'POST', body: JSON.stringify(sessionId ? { sessionId } : {}) });
        }
        const payload = await billingRequest<BillingCatalog>('/api/billing/catalog');
        if (disposed) return;
        setCatalog(payload);
        setError('');
        if (returned === 'success' && payload.currentPlanId === 'free') {
          setConfirmation('Payment confirmation is pending. No paid access has been granted yet.');
          setRecoverable(Boolean(payload.portalAvailable));
          if (attempt < 5) timer = setTimeout(() => void load(attempt + 1), 3000);
        } else if (payload.pastDue) {
          setRecoverable(true);
          setConfirmation('One payment method needs attention. Paid access is usually blocked until it is updated.');
        } else {
          setRecoverable(false);
          setConfirmation(returned === 'success' ? 'Your subscription has been verified.' : returned === 'cancelled' ? 'Checkout was cancelled. No plan change was made.' : '');
        }
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : 'The plan request failed; check your connection.');
          setConfirmation('');
        }
      } finally {
        if (!disposed) { setLoading(false); setRefreshing(false); }
      }
    };
    void load();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [reload]);
  const startCheckout = async (planId: string) => {
    setPendingPlan(planId);
    setError('');
    try {
      const payload = await billingRequest<{ url: string }>('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ planId }) });
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkout could not be started; check your connection.');
    } finally {
      setPendingPlan(null);
    }
  };
  const openPortal = async () => {
    setPendingPortal(true);
    setError('');
    try {
      const payload = await billingRequest<{ url: string }>('/api/billing/portal', { method: 'POST', body: '{}' });
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The billing portal request failed; check your connection.');
    } finally {
      setPendingPortal(false);
    }
  };
  const currentPlan = catalog ? catalog.plans.find(plan => plan.id === catalog.currentPlanId) ?? null : null;
  const currentName = currentPlan?.name ?? catalog?.currentPlanName ?? (catalog ? catalog.currentPlanId : 'unknown');
  const ownerAccess = catalog?.entitlements.unlimited === true;
  const selectedParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('selected') : null;
  const selectedPlan = catalog && selectedParam ? catalog.plans.find(plan => plan.id === selectedParam && plan.priceMonthlyUsd > 0 && plan.id !== catalog.currentPlanId) ?? null : null;
  return <><div className="page-heading"><div><div className="page-kicker">Plan and billing</div><h1>Choose your coverage.</h1><p>Plans set the authorized relay allowance, observation history window, ledger export, and access to experimental CSI research panels. Payment details are handled by the payment provider and never reach this console.</p></div>{catalog && <div className={`status-pill ${catalog.configured ? '' : 'warn'}`}><span className={`pulse-dot ${catalog.configured ? '' : 'amber'}`} />{catalog.configured ? `${currentName} plan` : 'BILLING NOT CONFIGURED'}</div>}</div>
    {loading && <div className="billing-notice" role="status" aria-live="polite" data-testid="billing-loading">Reading the current plan and entitlements…</div>}
    {selectedPlan && catalog?.configured && !ownerAccess && !catalog.subscriptionExists && (
      <div className="billing-notice" role="status" data-testid="billing-selected-plan">
        <strong>Ready to start {selectedPlan.name} ({usd(selectedPlan.priceMonthlyUsd)}/month).</strong>{' '}
        <span>Continue to secure Checkout to activate your {selectedPlan.name} allowance.</span>{' '}
        <button className="btn btn-primary" style={{ marginLeft: 10 }} disabled={pendingPlan !== null} onClick={() => void startCheckout(selectedPlan.id)}>
          {pendingPlan === selectedPlan.id ? 'Starting checkout…' : `Continue to ${selectedPlan.name} checkout`}
        </button>
      </div>
    )}
    {confirmation && !recoverable && <div className="billing-notice" role="status" aria-live="polite">{confirmation}</div>}
    {recoverable && catalog?.currentPlanId === 'free' && catalog?.configured && !ownerAccess && (
      <section className="billing-recovery" data-testid="billing-recovery">
        <div className="billing-recovery-icon">{catalog.status === 'past_due' && catalog.portalAvailable ? <Wrench size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}</div>
        <div>
          <p><strong className="billing-recovery-title">{catalog.status === 'past_due' && catalog.portalAvailable ? 'Update your payment method' : catalog.status.startsWith('incomplete') ? 'Payment confirmation is pending' : 'Fix your billing'}</strong></p>
          <p className="billing-recovery-sub">{confirmation}</p>
          {catalog.portalAvailable && (
            <button className="btn btn-primary" disabled={pendingPortal} onClick={() => void openPortal()}>
              {pendingPortal ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Opening billing…</> : (
                catalog.status === 'past_due' ? 'Update payment method in billing' : `Fix billing in the payment portal`
              )}
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
    )}
    {catalog && !catalog.configured && <div className="billing-notice" data-testid="billing-unconfigured"><strong>Billing is not configured for this deployment yet.</strong><span> No checkout can be started and no payment method can be added here. An operator must set the server-side payment secrets before plans become purchasable. The outline below is a reference plan, not an active offer:</span><ul>{referenceTierOutline.map(tier => <li key={tier.name}><strong>{tier.name}</strong> — {tier.summary}</li>)}</ul></div>}
    <button className="btn" disabled={refreshing || loading} onClick={() => { setRefreshing(true); setReload(value => value + 1); }}>{refreshing ? 'Refreshing…' : 'Refresh billing status'}</button>
    {error && <div className="billing-notice error" role="status" aria-live="polite" data-testid="billing-error">{error}</div>}
    {catalog && <section className="panel" data-testid="billing-current-plan"><div className="panel-header"><div><div className="panel-title">Current plan</div><div className="panel-subtitle">{currentName} · {ownerAccess ? 'deployment-configured owner access, no plan limits' : `subscription status ${catalog.status}`}</div></div>{catalog.portalAvailable && <button className="btn" data-testid="button-billing-portal" disabled={pendingPortal} onClick={() => void openPortal()}>{pendingPortal ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Opening billing…</> : 'Manage billing'}</button>}</div><div className="entitlement-grid">{entitlementRows(catalog.entitlements).map(row => <div className="entitlement" key={row}><Check size={13} aria-hidden="true" /><span>{row}</span></div>)}</div></section>}
    {catalog && catalog.plans.length > 0 && <div className="billing-grid">{catalog.plans.map(plan => {
      const isCurrent = plan.id === catalog.currentPlanId;
      const paid = plan.priceMonthlyUsd > 0;
      // The server decides purchasability: a paid plan whose price id is not configured
      // on this deployment is listed but cannot be bought here.
      const purchasable = typeof plan.purchasable === 'boolean' ? plan.purchasable : paid;
      return <div className={`panel plan-card ${isCurrent ? 'current' : ''}`} key={plan.id} data-testid={`plan-${plan.id}`}>
        <div className="plan-head"><div><div className="plan-name">{plan.name}</div><div className="plan-tagline">{plan.tagline}</div></div>{isCurrent && <span className="hardware-status connected">CURRENT PLAN</span>}</div>
        <div className="plan-price">{paid ? <>{usd(plan.priceMonthlyUsd)}<small>/mo</small></> : <>Free<small>no charge</small></>}</div>
        {plan.highlights.length > 0 && <ul className="plan-highlights">{plan.highlights.map(highlight => <li key={highlight}>{highlight}</li>)}</ul>}
        <div className="plan-entitlements">{entitlementRows(plan.entitlements).map(row => <span key={row}>{row}</span>)}</div>
        {isCurrent ? <button className="btn" disabled>Active plan</button> : ownerAccess ? <button className="btn" disabled>Included with owner access</button> : catalog.subscriptionExists && paid ? <button className="btn" disabled={pendingPortal} onClick={() => void openPortal()}>Change plan in billing portal</button> : purchasable ? <button className="btn btn-primary" data-testid={`button-upgrade-${plan.id}`} disabled={!catalog.configured || pendingPlan !== null} onClick={() => void startCheckout(plan.id)}>{pendingPlan === plan.id ? 'Starting checkout…' : `Upgrade to ${plan.name}`}</button> : <button className="btn" disabled>{paid ? 'Not enabled on this deployment' : 'Included with every account'}</button>}
      </div>;
    })}</div>}
    {ownerAccess && <div className="billing-notice" role="status" data-testid="billing-owner-notice"><strong>Owner access.</strong><span> This account is listed in the deployment's owner allowlist, so plan limits — relay allowance, history window, ledger export, and experimental CSI research panels — do not apply. It is configuration rather than a subscription: removing the account from <code>BACKSPYNE_OWNER_USER_IDS</code> returns it to the free plan, and no purchase or payment record is involved. Owner access lifts the plan gate only; research hardware, engines, and calibration are unaffected by it.</span></div>}
    {catalog && <p className="billing-disclaimer">Plan changes take effect after the payment provider confirms the subscription. BackSpyne enforces relay allowances server-side; history window, export, and research-panel availability follow the confirmed plan. Prices are shown in USD and exclude any applicable tax collected by the provider.</p>}
  </>;
}
