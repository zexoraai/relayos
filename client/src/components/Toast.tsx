import { signal } from '@preact/signals';

type ToastType = 'success' | 'error' | 'info' | 'warning';
interface ToastItem { id: number; message: string; type: ToastType; }

const toasts = signal<ToastItem[]>([]);
let nextId = 1;

export function toast(message: string, type: ToastType = 'info', duration = 3500) {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, type }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, duration);
}

const colors: Record<ToastType, string> = {
  success: 'bg-green-500',
  error: 'bg-red-500',
  info: 'bg-indigo-500',
  warning: 'bg-amber-500',
};

export function ToastContainer() {
  return (
    <div class="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2">
      {toasts.value.map((t) => (
        <div
          key={t.id}
          class={`${colors[t.type]} text-white px-5 py-3 rounded-2xl text-sm font-medium shadow-lg animate-fadeUp max-w-sm`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
