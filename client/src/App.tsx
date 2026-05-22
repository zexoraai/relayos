import { useEffect, useState } from 'preact/hooks';
import { Route, Switch, useLocation } from 'wouter-preact';
import { api, tokenSignal, setToken } from './lib/api';
import { Sidebar } from './components/Sidebar';
import { ToastContainer } from './components/Toast';
import { Spinner } from './components/Spinner';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';

interface MeResponse { tenant: { id: string; email: string; status: string }; }

/**
 * App shell:
 *   - On boot, validates the token via /auth/me
 *   - If unauthenticated: shows the auth routes
 *   - If authenticated: shows the dashboard layout with routed pages
 */
export function App() {
  const [, navigate] = useLocation();
  const [bootState, setBootState] = useState<'loading' | 'unauth' | 'onboarding' | 'ready'>('loading');

  // Re-run auth check whenever the token changes (login/logout)
  const token = tokenSignal.value;

  useEffect(() => {
    (async () => {
      if (!token) { setBootState('unauth'); return; }
      setBootState('loading');
      const { status, data } = await api<MeResponse>('GET', '/auth/me');
      if (status !== 200 || !data.success || !data.data) {
        setToken(null);
        setBootState('unauth');
        return;
      }
      setBootState(data.data.tenant.status === 'active' ? 'ready' : 'onboarding');
    })();
  }, [token]);

  if (bootState === 'loading') return <div class="min-h-screen flex items-center justify-center"><Spinner size="lg" /></div>;

  if (bootState === 'unauth') {
    return (
      <>
        <Switch>
          <Route path="/register"><Placeholder title="Register" /></Route>
          <Route><Login /></Route>
        </Switch>
        <ToastContainer />
      </>
    );
  }

  if (bootState === 'onboarding') {
    return (
      <>
        <Placeholder title="Onboarding" subtitle="The onboarding flow is being migrated. Use the legacy UI at /legacy.html for now." />
        <ToastContainer />
      </>
    );
  }

  return (
    <div class="flex min-h-screen">
      <Sidebar onLogout={() => { setToken(null); setBootState('unauth'); navigate('/'); }} />
      <main class="flex-1 ml-[240px] p-8 overflow-y-auto">
        <div class="max-w-7xl mx-auto">
          <Switch>
            <Route path="/"><Overview /></Route>
            <Route path="/pipeline"><Placeholder title="Pipeline" /></Route>
            <Route path="/fulfillment"><Placeholder title="Fulfillment" /></Route>
            <Route path="/customers"><Placeholder title="Customers" /></Route>
            <Route path="/agents"><Placeholder title="Agents" /></Route>
            <Route path="/caretaker"><Placeholder title="Caretaker" /></Route>
            <Route path="/whatsapp"><Placeholder title="WhatsApp" /></Route>
            <Route path="/inbox"><Placeholder title="Inbox" /></Route>
            <Route path="/knowledge"><Placeholder title="Knowledge" /></Route>
            <Route path="/settings"><Placeholder title="Settings" /></Route>
            <Route path="/failed"><Placeholder title="Failed Jobs" /></Route>
            <Route path="/health"><Placeholder title="Health" /></Route>
            <Route><Placeholder title="Not Found" /></Route>
          </Switch>
        </div>
      </main>
      <ToastContainer />
    </div>
  );
}

function Placeholder({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div class="animate-fadeUp">
      <h1 class="text-2xl font-bold tracking-tight">{title}</h1>
      {subtitle && <p class="text-sm text-gray-400 mt-1">{subtitle}</p>}
      <div class="bg-white rounded-3xl shadow-card p-12 mt-6 text-center">
        <p class="text-sm text-gray-400">This page is being migrated to the new frontend.</p>
        <p class="text-xs text-gray-300 mt-2">The legacy version is still available at <code>/legacy.html</code></p>
      </div>
    </div>
  );
}
