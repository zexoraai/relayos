export function EmptyState({ title, description, actionLabel, onAction }) {
    return (<div class="text-center py-12">
      <div class="text-4xl opacity-20 mb-3">◉</div>
      <h3 class="font-semibold text-base mb-1">{title}</h3>
      <p class="text-sm text-gray-400 max-w-xs mx-auto">{description}</p>
      {actionLabel && onAction && (<button onClick={onAction} class="mt-4 px-5 py-2 bg-brand-400 hover:bg-brand-500 text-gray-900 font-semibold rounded-full text-sm transition-all">
          {actionLabel}
        </button>)}
    </div>);
}
