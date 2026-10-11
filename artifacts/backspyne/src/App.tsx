// The console shell.
//
// This file decides only three things: how the application is wrapped (theme, query cache,
// auth), which address renders which view, and the chrome around them. Every view, every
// piece of console data, and every shared module lives in `views/`, `lib/`, and
// `components/`, so each can be read on its own.
//
// The address carries the view: `/user-portal/ledger` is the ledger, and it survives a
// refresh, a bookmark, a shared link, and the back button. An address that names no view
// falls back to the dashboard rather than rendering a blank frame.

import { useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, Show, useClerk } from '@clerk/react';
import { Redirect, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ErrorBoundary } from './components/error-boundary';
import { DeviceDrawer, Sidebar, Topbar } from './components/console';
import { Toaster } from './components/ui/toaster';
import { TooltipProvider } from './components/ui/tooltip';
import { ConsoleDataProvider, useConsoleData } from './lib/console-data';
import { basePath, clerkAppearance, clerkPubKey, clerkProxyUrl } from './lib/env';
import { VIEW_PATHS, viewFromPath, type NavView } from './lib/types';
import NotFound from './pages/not-found';
import { Billing } from './views/billing';
import { Calibration } from './views/calibration';
import { Dashboard } from './views/dashboard';
import { Hardware } from './views/hardware';
import { Ledger } from './views/ledger';
import { Nodes } from './views/nodes';
import { Admin } from './views/admin';
import { AuthNotConfigured, HomeRedirect, Landing, LegalPage, SignInPage, SignUpPage } from './views/public';
import { Sensing } from './views/sensing';

const queryClient = new QueryClient();

const VIEW_COMPONENTS: Record<NavView, () => JSX.Element> = {
  dashboard: Dashboard,
  ledger: Ledger,
  sensing: Sensing,
  nodes: Nodes,
  calibration: Calibration,
  hardware: Hardware,
  billing: Billing,
};

/** The signed-in console: chrome, the selected view, and nothing else. */
function Console() {
  const { mobileOpen, setMobileOpen, devices, nodes, liveMode, apiConnected, apiStatus, sessionId, signOut } = useConsoleData();
  const [location] = useLocation();
  const view = viewFromPath(location);
  const View = view ? VIEW_COMPONENTS[view] : null;

  return <div className="app-shell">
    <a className="skip-link" href="#console-main">Skip to the measurement view</a>
    <Sidebar
      view={view ?? 'dashboard'}
      mobileOpen={mobileOpen}
      onClose={() => setMobileOpen(false)}
      devices={devices}
      nodes={nodes}
      liveMode={liveMode}
      apiConnected={apiConnected}
      apiStatus={apiStatus}
    />
    <div className="main-content">
      <Topbar
        view={view ?? 'dashboard'}
        scanning={liveMode}
        apiStatus={apiStatus}
        onOpenMenu={() => setMobileOpen(true)}
        sessionId={sessionId}
        onSignOut={signOut}
      />
      <main className="content" id="console-main" tabIndex={-1}>
        {View ? <View /> : <Redirect to={VIEW_PATHS.dashboard} />}
      </main>
    </div>
    {/* One drawer for the whole console: every view selects a radio the same way. */}
    <DeviceDrawer />
  </div>;
}

/** Discards cached operator data when the signed-in account changes. */
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) queryClient.clear();
    previousUserId.current = userId;
  }), [addListener]);
  return null;
}

function UserPortal() {
  return <>
    <Show when="signed-in"><ConsoleDataProvider><Console /></ConsoleDataProvider></Show>
    <Show when="signed-out"><Redirect to="/" /></Show>
  </>;
}

function Router() {
  return <ErrorBoundary><Switch>
    <Route path="/legal" component={LegalPage} />
    {/* The administrator surface is deliberately outside the operator portal and outside
        Clerk: it is the deployment owner's own account, and it has to work on a deployment
        where no identity provider is configured. */}
    <Route path="/admin/*?" component={Admin} />
    <Route path="/" component={clerkPubKey ? HomeRedirect : Landing} />
    <Route path="/user-portal/*?" component={clerkPubKey ? UserPortal : AuthNotConfigured} />
    <Route path="/sign-in/*?" component={clerkPubKey ? SignInPage : AuthNotConfigured} />
    <Route path="/sign-up/*?" component={clerkPubKey ? SignUpPage : AuthNotConfigured} />
    <Route component={NotFound} />
  </Switch></ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
  const content = <QueryClientProvider client={queryClient}><Router /></QueryClientProvider>;
  if (!clerkPubKey) return content;
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your operator portal' } }, signUp: { start: { title: 'Create operator access', subtitle: 'Keep your authorized sensing sessions accountable' } } }} routerPush={to => setLocation(stripBase(to))} routerReplace={to => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><Router /></QueryClientProvider></ClerkProvider>;
}

export default function App() {
  return <TooltipProvider><WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter><Toaster /></TooltipProvider>;
}
