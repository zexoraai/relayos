import { signal } from '@preact/signals';
export const tokenSignal = signal(localStorage.getItem('token'));
export async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (tokenSignal.value)
        opts.headers['Authorization'] = 'Bearer ' + tokenSignal.value;
    if (body !== undefined)
        opts.body = JSON.stringify(body);
    try {
        const res = await fetch(path, opts);
        const data = await res.json();
        if (res.status === 401) {
            tokenSignal.value = null;
            localStorage.removeItem('token');
        }
        return { status: res.status, data };
    }
    catch (e) {
        return { status: 0, data: { success: false, error: { code: 'NETWORK', message: e.message } } };
    }
}
export function setToken(token) {
    tokenSignal.value = token;
    if (token)
        localStorage.setItem('token', token);
    else
        localStorage.removeItem('token');
}
