export function Spinner({ size = 'md' }) {
    const px = size === 'sm' ? 'w-4 h-4 border-2' : size === 'lg' ? 'w-8 h-8 border-[3px]' : 'w-6 h-6 border-2';
    return (<div class="flex items-center justify-center py-12">
      <div class={`${px} border-brand-400 border-t-transparent rounded-full animate-spin`}/>
    </div>);
}
