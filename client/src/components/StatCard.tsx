import type { ComponentChildren } from 'preact';

interface Props {
  label: string;
  value: ComponentChildren;
  color?: string;
  hint?: string;
  onClick?: () => void;
}

/**
 * Compact stat card used across Overview, Pipeline, Failed Jobs, etc.
 */
export function StatCard({ label, value, color = 'text-gray-900', hint, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      class={`bg-white rounded-2xl shadow-card p-5 transition-all hover:-translate-y-0.5 hover:shadow-card-hover ${onClick ? 'cursor-pointer' : ''}`}
    >
      <div class="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div class={`text-3xl font-bold mt-1 tracking-tight ${color}`}>{value}</div>
      {hint && <div class="text-[11px] text-gray-400 mt-1">{hint}</div>}
    </div>
  );
}
