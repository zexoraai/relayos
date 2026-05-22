import type { ComponentChildren } from 'preact';

interface Props {
  title?: string;
  action?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}

export function Card({ title, action, children, class: className = '' }: Props) {
  return (
    <div class={`bg-white rounded-3xl shadow-card p-6 ${className}`}>
      {(title || action) && (
        <div class="flex items-center justify-between mb-5">
          {title && <h3 class="font-bold text-base">{title}</h3>}
          {action && <div>{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
