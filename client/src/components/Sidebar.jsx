import { useLocation } from 'wouter-preact';
const sections = [
    {
        label: 'Operations',
        items: [
            { label: 'Overview', path: '/' },
            { label: 'Pipeline', path: '/pipeline' },
            { label: 'Fulfillment', path: '/fulfillment' },
            { label: 'Customers', path: '/customers' },
        ],
    },
    {
        label: 'AI & Messaging',
        items: [
            { label: 'Agents', path: '/agents' },
            { label: 'Caretaker', path: '/caretaker' },
            { label: 'WhatsApp', path: '/whatsapp' },
            { label: 'Inbox', path: '/inbox' },
        ],
    },
    {
        label: 'Configuration',
        items: [
            { label: 'Knowledge', path: '/knowledge' },
            { label: 'Settings', path: '/settings' },
        ],
    },
    {
        label: 'System',
        items: [
            { label: 'Failed Jobs', path: '/failed' },
            { label: 'Health', path: '/health' },
        ],
    },
];
export function Sidebar({ onLogout }) {
    const [location, navigate] = useLocation();
    return (<aside class="w-[240px] bg-dark-900 text-white flex flex-col fixed inset-y-0 left-0 z-50">
      <div class="px-6 py-6">
        <h1 class="text-xl font-extrabold text-brand-400 tracking-tight">RelayOS</h1>
      </div>
      <nav class="flex-1 overflow-y-auto px-3">
        <ul class="space-y-0.5">
          {sections.map((section) => (<>
              <li class="px-3 pt-4 pb-1 text-[10px] uppercase tracking-widest text-gray-500 font-semibold">{section.label}</li>
              {section.items.map((item) => {
                const active = location === item.path;
                return (<li key={item.path} onClick={() => navigate(item.path)} class={`sidebar-item ${active ? 'active' : ''}`}>
                    <span>{item.label}</span>
                  </li>);
            })}
            </>))}
        </ul>
      </nav>
      <div class="px-6 py-4 border-t border-white/5">
        <button onClick={onLogout} class="w-full py-2 text-xs text-gray-400 hover:text-white transition-colors">
          Sign Out
        </button>
      </div>
    </aside>);
}
