// Plan and billing.
//
// The catalog is the server's: whether a plan can be bought on this deployment, what each
// plan entitles an operator to, and which plan this account is on. The view renders that
// truth — including the honest case where no payment provider is configured yet — and never
// infers a purchase from a redirect.

import { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';

import { usd } from '../lib/format';
import type { BillingCatalog, BillingEntitlements } from '../lib/types';

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
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch('/api/billing/catalog', { credentials: 'include' });
        if (disposed) return;
        if (response.status === 401 || response.status === 503) {
          setError('The operator API is unavailable, so the current plan cannot be read.');
          setCatalog(null);
          return;
        }
        if (!response.ok) {
          setError(`The plan request failed (${response.status}).`);
          setCatalog(null);
          return;
        }
        setCatalog(await response.json() as BillingCatalog);
        setError('');
      } catch {
        if (!disposed) {
          setError('The plan request failed; check your connection.');
          setCatalog(null);
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; };
  }, []);
  const readError = async (response: Response, fallback: string) => {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    return typeof payload?.error === 'string' && payload.error ? payload.error : fallback;
  };
  const startCheckout = async (planId: string) => {
    setPendingPlan(planId);
    setError('');
    try {
      const response = await fetch('/api/billing/checkout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId }) });
      const payload = await response.json().catch(() => null) as { url?: unknown } | null;
      if (response.ok && typeof payload?.url === 'string' && payload.url) {
        window.location.assign(payload.url);
        return;
      }
      setError(await readError(response, response.status === 503 ? 'Billing is not configured for this deployment yet.' : `Checkout could not be started (${response.status}).`));
    } catch {
      setError('Checkout could not be started; check your connection.');
    } finally {
      setPendingPlan(null);
    }
  };
  const openPortal = async () => {
    setPendingPortal(true);
    setError('');
    try {
      const response = await fetch('/api/billing/portal', { method: 'POST', credentials: 'include' }).catch(() => null);
      if (!response) {
        setError('The billing portal request failed; check your connection.');
        return;
      }
      const payload = await response.json().catch(() => null) as { url?: unknown } | null;
      if (response.ok && typeof payload?.url === 'string' && payload.url) {
        window.location.assign(payload.url);
        return;
      }
      setError(await readError(response, `The billing portal is unavailable (${response.status}).`));
    } finally {
      setPendingPortal(false);
    }
  };
  const currentPlan = catalog ? catalog.plans.find(plan => plan.id === catalog.currentPlanId) ?? null : null;
  const currentName = currentPlan?.name ?? catalog?.currentPlanName ?? (catalog ? catalog.currentPlanId : 'unknown');
  const ownerAccess = catalog?.entitlements.unlimited === true;
  return <><div className="page-heading"><div><div className="page-kicker">Plan and billing</div><h1>Choose your coverage.</h1><p>Plans set the authorized relay allowance, observation history window, ledger export, and access to experimental CSI research panels. Payment details are handled by the payment provider and never reach this console.</p></div>{catalog && <div className={`status-pill ${catalog.configured ? '' : 'warn'}`}><span className={`pulse-dot ${catalog.configured ? '' : 'amber'}`} />{catalog.configured ? `${currentName} plan` : 'BILLING NOT CONFIGURED'}</div>}</div>
    {loading && <div className="billing-notice" role="status" aria-live="polite" data-testid="billing-loading">Reading the current plan and entitlements…</div>}
    {error && <div className="billing-notice error" role="status" aria-live="polite" data-testid="billing-error">{error}</div>}
    {catalog && !catalog.configured && <div className="billing-notice" data-testid="billing-unconfigured"><strong>Billing is not configured for this deployment yet.</strong><span> No checkout can be started and no payment method can be added here. An operator must set the server-side payment secrets before plans become purchasable. The outline below is a reference plan, not an active offer:</span><ul>{referenceTierOutline.map(tier => <li key={tier.name}><strong>{tier.name}</strong> — {tier.summary}</li>)}</ul></div>}
    {catalog && <section className="panel" data-testid="billing-current-plan"><div className="panel-header"><div><div className="panel-title">Current plan</div><div className="panel-subtitle">{currentName} · {ownerAccess ? 'deployment-configured owner access, no plan limits' : `subscription status ${catalog.status}`}</div></div>{catalog.currentPlanId !== 'free' && !ownerAccess && <button className="btn" data-testid="button-billing-portal" disabled={pendingPortal} onClick={() => void openPortal()}>{pendingPortal ? <><RefreshCw className="spin" size={13} aria-hidden="true" /> Opening portal…</> : 'Manage billing'}</button>}</div><div className="entitlement-grid">{entitlementRows(catalog.entitlements).map(row => <div className="entitlement" key={row}><Check size={13} aria-hidden="true" /><span>{row}</span></div>)}</div></section>}
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
        {isCurrent ? <button className="btn" disabled>Active plan</button> : purchasable ? <button className="btn btn-primary" data-testid={`button-upgrade-${plan.id}`} disabled={!catalog.configured || pendingPlan !== null} onClick={() => void startCheckout(plan.id)}>{pendingPlan === plan.id ? 'Starting checkout…' : `Upgrade to ${plan.name}`}</button> : <button className="btn" disabled>{paid ? 'Not enabled on this deployment' : 'Included with every account'}</button>}
      </div>;
    })}</div>}
    {ownerAccess && <div className="billing-notice" role="status" data-testid="billing-owner-notice"><strong>Owner access.</strong><span> This account is listed in the deployment's owner allowlist, so plan limits — relay allowance, history window, ledger export, and experimental CSI research panels — do not apply. It is configuration rather than a subscription: removing the account from <code>BACKSPYNE_OWNER_USER_IDS</code> returns it to the free plan, and no purchase or payment record is involved. Owner access lifts the plan gate only; research hardware, engines, and calibration are unaffected by it.</span></div>}
    {catalog && <p className="billing-disclaimer">Plan changes take effect after the payment provider confirms the subscription. BackSpyne enforces relay allowances server-side; history window, export, and research-panel availability follow the confirmed plan. Prices are shown in USD and exclude any applicable tax collected by the provider.</p>}
  </>;
}
