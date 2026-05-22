const colors = {
    completed: 'bg-green-50 text-green-600',
    active: 'bg-green-50 text-green-600',
    delivered: 'bg-green-50 text-green-600',
    processing: 'bg-blue-50 text-blue-600',
    in_transit: 'bg-blue-50 text-blue-600',
    failed: 'bg-red-50 text-red-500',
    rejected: 'bg-red-50 text-red-500',
    cancelled: 'bg-red-50 text-red-500',
    pending: 'bg-gray-100 text-gray-600',
    pending_review: 'bg-amber-50 text-amber-600',
    warning: 'bg-amber-50 text-amber-600',
};
/**
 * Status pill shown next to job rows, order rows, evaluations, etc.
 */
export function Badge({ status, text }) {
    const cls = colors[status] || 'bg-gray-100 text-gray-600';
    return (<span class={`inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${cls}`}>
      {(text || status || '').replace(/_/g, ' ')}
    </span>);
}
