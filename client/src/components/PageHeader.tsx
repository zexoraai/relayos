interface Props {
  title: string;
  subtitle?: string;
  action?: preact.ComponentChildren;
}

export function PageHeader({ title, subtitle, action }: Props) {
  return (
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p class="text-sm text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
