import { signal } from '@preact/signals';

export const tokenSignal = signal<string | null>(localStorage.getItem('token'));

export interface ApiResult<T = any> {
  status: number;
  data: { success: boolean; data?: T; error?: { code: string; message: string; fields?: any } };
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<ApiResult<T>> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (tokenSignal.value) (opts.headers as any)['Authorization'] = 'Bearer ' + tokenSignal.value;
  if (body !== undefined) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(path, opts);
    const data = await res.json();
    if (res.status === 401) {
      tokenSignal.value = null;
      localStorage.removeItem('token');
    }
    return { status: res.status, data };
  } catch (e: any) {
    return { status: 0, data: { success: false, error: { code: 'NETWORK', message: e.message } } };
  }
}

export function setToken(token: string | null) {
  tokenSignal.value = token;
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}
