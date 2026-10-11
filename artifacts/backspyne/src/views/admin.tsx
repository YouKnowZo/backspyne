// The deployment's revenue surface.
//
// This page answers two questions and refuses to guess at either. Before sign-in it asks the
// deployment whether admin access exists at all, so a visitor sees the two environment
// variables that would enable it instead of a form that can only fail. After sign-in it shows
// what the deployment is actually earning — monthly recurring revenue, the plan mix, the
// usage those plans pay for — read from the subscriptions the payment provider confirmed.
//
// Two rules hold throughout. Money is never computed here: every figure comes from the server,
// so the page cannot drift from what customers are charged. And a figure that cannot be read is
// shown as the reason it could not be read, never as a zero, because a zero on a revenue page
// reads as "we earned nothing" rather than "we could not tell".
//
// Admin access is separate from the operator portal: a credential configured on the deployment
// exchanged for a session cookie, so it works on a deployment without Clerk and it grants no
// access to any operator's measured data.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, BarChart3, DollarSign, KeyRound, Loader2, LogOut, RefreshCw, ShieldCheck, Users } from 'lucide-react';

import { Brand } from '../components/console';
import { basePath } from '../lib/env';
import {
  describeArpa,
  formatUsd,
  planShare,
  readAdminRevenue,
  readAdminSession,
  signInAdmin,
  signOutAdmin,
  type AdminRevenue,
  type AdminRevenueAvailable,
  type AdminSession,
} from '../lib/admin';

type LoadState = 'loading' | 'ready' | 'error';

/** The environment variables that turn this page on, stated where they are needed. */
const ADMIN_ENV_NOTE = 'Set BACKSPYNE_ADMIN_EMAIL and BACKSPYNE_ADMIN_PASSWORD_HASH (or BACKSPYNE_ADMIN_PASSWORD for a simple deployment) on the server to enable admin access.';

/** Turns whatever the server said into the sentence an operator should read. */
function signInErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (/too many|attempt/i.test(text)) return 'Too many sign-in attempts. Wait a few minutes and try again.';
  if (/unauthorized|credential|password|match/i.test(text)) return 'Those credentials do not match the configured admin account.';
  if (/not configured/i.test(text)) return 'Admin access is not configured on this deployment.';
  return text || 'Sign-in failed.';
}

function Tiles({ revenue }: { revenue: AdminRevenueAvailable }) {
  const tiles: Array<{ label: string; value: string; note: string }> = [
    { label: 'Monthly recurring revenue', value: `${formatUsd(revenue.revenue.mrrUsd)}`, note: 'Confirmed subscriptions only · per month' },
    { label: 'Paying operators', value: String(revenue.revenue.payingOperators), note: `${revenue.totals.subscriptions} subscription record${revenue.totals.subscriptions === 1 ? '' : 's'} stored` },
    { label: 'On a trial', value: String(revenue.revenue.trialingOperators), note: 'Trialing counts as entitled until it ends' },
    { label: 'Free accounts', value: String(revenue.revenue.freeOperators), note: 'No subscription, free plan limits apply' },
    { label: 'Average per paying operator', value: revenue.revenue.arpaUsd === null ? '—' : formatUsd(revenue.revenue.arpaUsd), note: describeArpa(revenue.revenue.arpaUsd) },
  ];
  return <div className="admin-tiles" data-testid="admin-revenue-tiles">
    {tiles.map(tile => <div className="admin-tile" key={tile.label}>
      <div className="eyebrow">{tile.label}</div>
      <strong>{tile.value}</strong>
      <small>{tile.note}</small>
    </div>)}
  </div>;
}

function PlanMix({ revenue }: { revenue: AdminRevenueAvailable }) {
  if (!revenue.plans.length) return <p className="admin-note">No plan has a single operator on it yet.</p>;
  const shares = new Map(planShare(revenue.plans).map(share => [share.planId, share.sharePercent] as const));
  return <div className="admin-mix" data-testid="admin-plan-mix">
    {revenue.plans.map(plan => {
      const share = shares.get(plan.planId) ?? 0;
      return <div className="admin-mix-row" key={plan.planId} data-testid={`admin-plan-${plan.planId}`}>
        <div className="admin-mix-head">
          <span className="admin-mix-name">{plan.name}</span>
          <span className="admin-mix-figure">{plan.operators} operator{plan.operators === 1 ? '' : 's'} · {formatUsd(plan.mrrUsd)}/mo</span>
        </div>
        <span className="admin-mix-track" aria-hidden="true"><b style={{ width: `${Math.max(share > 0 ? 2 : 0, share)}%` }} /></span>
        <span className="admin-mix-share">{share}% of operators · list price {formatUsd(plan.priceMonthlyUsd)}/mo</span>
      </div>;
    })}
  </div>;
}

function Usage({ revenue }: { revenue: AdminRevenueAvailable }) {
  const rows: Array<[string, number]> = [
    ['Operators seen', revenue.usage.operators],
    ['Authorized relays', revenue.usage.relays],
    ['Relays reporting', revenue.usage.activeRelays],
    ['Radios observed', revenue.usage.devices],
    ['Sightings, 30 days', revenue.usage.sightings30d],
    ['Scan sessions', revenue.usage.sessions],
    ['Calibrations fitted', revenue.usage.calibrations],
  ];
  return <div className="admin-usage" data-testid="admin-usage">
    {rows.map(([label, value]) => <div className="admin-usage-cell" key={label}>
      <div className="eyebrow">{label}</div>
      <strong>{value}</strong>
    </div>)}
  </div>;
}

function RecentSubscriptions({ revenue }: { revenue: AdminRevenueAvailable }) {
  if (!revenue.recent.length) return <p className="admin-note">No subscription record has been written yet. A record appears after the payment provider confirms one.</p>;
  return <div className="location-table admin-recent" data-testid="admin-recent-subscriptions">
    <div className="list-head" aria-hidden="true"><span>Operator</span><span>Plan</span><span>Status</span><span>Updated</span></div>
    {revenue.recent.map(row => <div className="location-row" key={`${row.ownerId}-${row.updatedAt}`}>
      <span title={row.ownerId}>{row.ownerId}</span>
      <span>{row.planId}</span>
      <span>{row.status}</span>
      <span>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : 'unknown'}</span>
    </div>)}
  </div>;
}

export function Admin() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [revenue, setRevenue] = useState<AdminRevenue | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'signing-in' | 'signing-out' | 'refreshing'>('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const loadRevenue = useCallback(async () => {
    try {
      setRevenue(await readAdminRevenue());
      setError('');
    } catch (caught) {
      setRevenue(null);
      setError(caught instanceof Error ? caught.message : 'Revenue could not be read.');
    }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const next = await readAdminSession();
      setSession(next);
      setState('ready');
      setError('');
      if (next.signedIn) await loadRevenue();
      else setRevenue(null);
    } catch (caught) {
      setSession(null);
      setState('error');
      setError(caught instanceof Error ? caught.message : 'The admin session could not be read.');
    }
  }, [loadRevenue]);

  useEffect(() => { void loadSession(); }, [loadSession]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter the configured admin email and password.');
      return;
    }
    setBusy('signing-in');
    setError('');
    try {
      await signInAdmin(email.trim(), password);
      setPassword('');
      await loadSession();
    } catch (caught) {
      setError(signInErrorMessage(caught));
    } finally {
      setBusy('');
    }
  };

  const signOut = async () => {
    setBusy('signing-out');
    setError('');
    try {
      await signOutAdmin();
      setRevenue(null);
      await loadSession();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-out failed.');
    } finally {
      setBusy('');
    }
  };

  const refresh = async () => {
    setBusy('refreshing');
    await loadRevenue();
    setBusy('');
  };

  const configured = session?.configured ?? true;
  const signedIn = session?.signedIn === true;

  return <div className="admin-shell"><div className="admin-inner">
    <header className="admin-top">
      <Brand />
      <div className="admin-top-actions">
        <a className="btn" href={`${basePath}/user-portal`}>Operator console <ArrowUpRight size={13} aria-hidden="true" /></a>
        {signedIn && <button className="btn" disabled={busy !== ''} onClick={() => void signOut()} data-testid="admin-signout">
          {busy === 'signing-out' ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <LogOut size={13} aria-hidden="true" />} Sign out
        </button>}
      </div>
    </header>

    <div className="admin-heading">
      <div className="page-kicker">Deployment administration</div>
      <h1>What this deployment is earning.</h1>
      <p>
        Plan mix, confirmed subscriptions, and the usage those plans pay for. This surface reads the deployment's own
        subscription records; it manages no operator's measurements and is signed in separately from the operator portal.
      </p>
    </div>

    {state === 'loading' && <div className="panel admin-loading" data-testid="admin-loading"><Loader2 className="spin" size={15} aria-hidden="true" /> Reading the admin session…</div>}

    {state !== 'loading' && !configured && <section className="panel admin-card" data-testid="admin-not-configured">
      <div className="panel-header"><div><div className="panel-title">Admin access is not configured</div><div className="panel-subtitle">No admin credential exists on this deployment</div></div><KeyRound size={16} aria-hidden="true" /></div>
      <p className="admin-note">{ADMIN_ENV_NOTE} Until then no sign-in can succeed here, and no admin figure is shown.</p>
    </section>}

    {state !== 'loading' && configured && !signedIn && <section className="panel admin-card" data-testid="admin-signin-panel">
      <div className="panel-header"><div><div className="panel-title">Admin sign-in</div><div className="panel-subtitle">One credential, configured on the server</div></div><ShieldCheck size={16} aria-hidden="true" /></div>
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="admin-email-input">Admin email</label>
          <input
            id="admin-email-input"
            name="admin-email"
            type="email"
            autoComplete="username"
            inputMode="email"
            data-testid="admin-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
          />
        </div>
        <div className="field">
          <label htmlFor="admin-password-input">Password</label>
          <input
            id="admin-password-input"
            name="admin-password"
            type="password"
            autoComplete="current-password"
            data-testid="admin-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••••"
          />
        </div>
        <div className="admin-form-actions">
          <button className="btn btn-primary" type="submit" disabled={busy !== ''} data-testid="admin-signin">
            {busy === 'signing-in' ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />} Sign in
          </button>
          <span className="admin-note">Attempts are rate limited. The session lasts twelve hours and is stored in an httpOnly cookie.</span>
        </div>
      </form>
    </section>}

    {state === 'ready' && signedIn && <section className="panel admin-card admin-session" data-testid="admin-session">
      <div className="panel-header">
        <div>
          <div className="panel-title">Signed in as {session?.email}</div>
          <div className="panel-subtitle">
            Owner id <code>{session?.ownerId}</code> · session expires {session?.expiresAt ? new Date(session.expiresAt).toLocaleString() : 'unknown'}
          </div>
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={busy !== ''} data-testid="admin-refresh">
          {busy === 'refreshing' ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />} Refresh figures
        </button>
      </div>
    </section>}

    {signedIn && error && <div className="billing-notice error" role="status" data-testid="admin-error">{error}</div>}
    {!signedIn && error && <div className="billing-notice error" role="status" data-testid="admin-signin-error">{error}</div>}

    {signedIn && revenue && !revenue.available && <section className="panel admin-card" data-testid="admin-revenue-unavailable">
      <div className="panel-header"><div><div className="panel-title">Revenue is not available</div><div className="panel-subtitle">The figures could not be read, so none are shown</div></div><DollarSign size={16} aria-hidden="true" /></div>
      <p className="admin-note">{revenue.reason}</p>
    </section>}

    {signedIn && revenue && revenue.available && <>
      <Tiles revenue={revenue} />
      <section className="panel admin-card" data-testid="admin-plan-mix-panel">
        <div className="panel-header">
          <div><div className="panel-title">Plan mix</div><div className="panel-subtitle">{formatUsd(revenue.revenue.mrrUsd)} monthly recurring · read {new Date(revenue.generatedAt).toLocaleString()}</div></div>
          <BarChart3 size={16} aria-hidden="true" />
        </div>
        <PlanMix revenue={revenue} />
      </section>
      <section className="panel admin-card" data-testid="admin-usage-panel">
        <div className="panel-header">
          <div><div className="panel-title">Usage behind the revenue</div><div className="panel-subtitle">Counts across every account on this deployment</div></div>
          <Users size={16} aria-hidden="true" />
        </div>
        <Usage revenue={revenue} />
        <p className="admin-note">
          {revenue.totals.billingEvents} billing event{revenue.totals.billingEvents === 1 ? '' : 's'} recorded. A plan is honored only while the
          payment provider reports it as active or trialing, so a lapsed subscription shows here as free on the next request.
        </p>
      </section>
      <section className="panel admin-card" data-testid="admin-payments-panel">
        <div className="panel-header"><div><div className="panel-title">Revenue collection</div><div className="panel-subtitle">{revenue.plan.configured ? 'A payment provider is configured' : 'No payment provider is configured'}</div></div><DollarSign size={16} aria-hidden="true" /></div>
        {revenue.plan.configured
          ? <p className="admin-note">
            Checkout is live for Solo {formatUsd(revenue.plan.pricesUsd.solo)}/month, Team {formatUsd(revenue.plan.pricesUsd.team)}/month, and
            Consultant {formatUsd(revenue.plan.pricesUsd.consultant)}/month. A plan with no configured price is listed in the catalog but cannot be bought.
          </p>
          : <p className="admin-note">
            No plan can be purchased on this deployment yet: the payment provider secrets are unset, so checkout returns
            “billing is not configured” rather than taking a payment it cannot complete. Every account therefore sits on the free plan.
          </p>}
      </section>
      <section className="panel admin-card" data-testid="admin-recent-panel">
        <div className="panel-header"><div><div className="panel-title">Recent subscription changes</div><div className="panel-subtitle">Newest first, as the payment provider reported them</div></div></div>
        <RecentSubscriptions revenue={revenue} />
      </section>
    </>}

    <footer className="admin-footer">
      {/* What this surface actually reaches, stated plainly: the counts above are deployment-wide,
          and anything owner-scoped belongs to the configured admin owner id. Claiming it read no
          measurements at all would be false on this very page. */}
      <span>Admin access is separate from the operator portal. The usage counts above are deployment-wide; any operator record it can open is the one scoped to the configured admin owner id, and another operator's measurements stay in their own account.</span>
      <a className="legal-link" href={`${basePath}/`}>BackSpyne home</a>
    </footer>
  </div></div>;
}
