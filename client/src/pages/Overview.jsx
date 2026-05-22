import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { Spinner } from '../components/Spinner';
export function Overview() {
    const [, navigate] = useLocation();
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState({ status: '-' });
    const [stats, setStats] = useState({ total: 0, by_status: {} });
    const [jobs, setJobs] = useState([]);
    const [fulfillment, setFulfillment] = useState([]);
    useEffect(() => {
        (async () => {
            const [s, st, j, f] = await Promise.all([
                api('GET', '/onboarding/status'),
                api('GET', '/pipeline/stats'),
                api('GET', '/pipeline/jobs?limit=8'),
                api('GET', '/fulfillment/jobs?limit=5'),
            ]);
            if (s.data.success)
                setStatus(s.data.data);
            if (st.data.success)
                setStats(st.data.data);
            if (j.data.success)
                setJobs(j.data.data.jobs);
            if (f.data.success)
                setFulfillment(f.data.data.jobs);
            setLoading(false);
        })();
    }, []);
    if (loading)
        return <Spinner />;
    const agentList = ['Data Extraction', 'Caretaker AI', 'Intent Router', 'Order Support', 'Tenant Info'];
    return (<div class="animate-fadeUp">
      <PageHeader title="Overview" subtitle="Welcome back"/>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Orders" value={stats.total}/>
        <StatCard label="Completed" value={stats.by_status.completed || 0} color="text-green-600"/>
        <StatCard label="Processing" value={stats.by_status.processing || 0} color="text-blue-600"/>
        <StatCard label="Failed" value={stats.by_status.failed || 0} color="text-red-500"/>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div class="lg:col-span-2">
          <Card title="Recent Activity" action={<button onClick={() => navigate('/pipeline')} class="text-xs text-brand-600 font-semibold hover:underline">
                View all
              </button>}>
            {jobs.length === 0 ? (<EmptyState title="No activity yet" description="Send an order email to trigger the pipeline."/>) : (<div class="space-y-3">
                {jobs.map((j) => (<div key={j.id} class="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                    <div>
                      <div class="text-sm font-medium capitalize">{j.current_stage.replace(/_/g, ' ').toLowerCase()}</div>
                      <div class="text-xs text-gray-400">{new Date(j.created_at).toLocaleString()}</div>
                    </div>
                    <Badge status={j.status}/>
                  </div>))}
              </div>)}
          </Card>
        </div>

        <div class="space-y-6">
          <Card title="Account">
            <div class="space-y-3 text-sm">
              <Row label="Status" value={<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-green-400"/>{status.status}</span>}/>
              <Row label="Platform" value={status.ecommerce_platform || '-'}/>
              <Row label="Plan" value={status.shopify_plan || '-'}/>
              <Row label="Courier" value={(status.courier || '-').toUpperCase()}/>
            </div>
          </Card>

          <div class="bg-dark-800 rounded-3xl p-6 text-white">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-bold text-base">AI Agents</h3>
              <button onClick={() => navigate('/agents')} class="text-xs text-brand-400 font-semibold hover:underline">
                Details
              </button>
            </div>
            {agentList.map((name) => (<div key={name} class="flex items-center gap-3 py-1.5">
                <span class="w-2 h-2 rounded-full bg-green-400 animate-pulseDot"/>
                <span class="text-sm text-gray-300">{name}</span>
              </div>))}
          </div>

          <Card title="Fulfillment" action={<button onClick={() => navigate('/fulfillment')} class="text-xs text-brand-600 font-semibold hover:underline">
                View
              </button>}>
            {fulfillment.length === 0 ? (<p class="text-sm text-gray-400">No active jobs</p>) : (fulfillment.slice(0, 4).map((j) => (<div key={j.id} class="flex items-center justify-between py-1.5">
                  <span class="text-sm text-gray-600">{j.waybill || '-'}</span>
                  <Badge status={milestoneStatus(j.milestone)} text={(j.milestone || 'pending').replace(/_/g, ' ')}/>
                </div>)))}
          </Card>
        </div>
      </div>
    </div>);
}
function milestoneStatus(m) {
    if (m === 'delivered')
        return 'completed';
    if (m === 'cancelled' || m === 'failed')
        return 'failed';
    return 'processing';
}
function Row({ label, value }) {
    return (<div class="flex justify-between items-center">
      <span class="text-gray-400">{label}</span>
      <span class="font-medium">{value}</span>
    </div>);
}
