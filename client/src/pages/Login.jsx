import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { api, setToken } from '../lib/api';
export function Login() {
    const [, navigate] = useLocation();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    async function submit(e) {
        e.preventDefault();
        setError('');
        setLoading(true);
        const { data } = await api('POST', '/auth/login', { email, password });
        setLoading(false);
        if (!data.success || !data.data) {
            setError(data.error?.message || 'Login failed');
            return;
        }
        setToken(data.data.token);
        // App component will re-render and show dashboard automatically via tokenSignal
    }
    return (<div class="min-h-screen flex items-center justify-center p-6">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <h1 class="text-3xl font-extrabold tracking-tight text-brand-600">RelayOS</h1>
          <p class="text-sm text-gray-400 mt-1">Intelligent order fulfillment</p>
        </div>
        <form onSubmit={submit} class="bg-white rounded-3xl shadow-elevated p-8">
          <h2 class="text-xl font-bold mb-1">Welcome back</h2>
          <p class="text-sm text-gray-400 mb-6">Sign in to your account</p>
          <div class="space-y-4">
            <Field label="Email" type="email" value={email} onInput={setEmail} placeholder="you@company.com"/>
            <Field label="Password" type="password" value={password} onInput={setPassword} placeholder="Enter password"/>
          </div>
          {error && <p class="text-red-500 text-xs mt-2">{error}</p>}
          <button type="submit" disabled={loading} class="w-full mt-6 py-3 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full transition-all hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
          <p class="text-center text-xs text-gray-400 mt-4">
            Don't have an account?{' '}
            <a onClick={() => navigate('/register')} class="text-brand-600 font-semibold cursor-pointer hover:underline">
              Register
            </a>
          </p>
        </form>
      </div>
    </div>);
}
function Field({ label, type, value, onInput, placeholder }) {
    return (<div>
      <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{label}</label>
      <input type={type} value={value} onInput={(e) => onInput(e.currentTarget.value)} placeholder={placeholder} class="w-full px-4 py-3 bg-surface-100 rounded-xl text-sm border-0 focus:ring-2 focus:ring-brand-400 focus:bg-white transition-all"/>
    </div>);
}
