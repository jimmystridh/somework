export class ApiError extends Error {
  constructor(status, body) {
    super(body?.detail || `request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
    this.traceId = body?.traceId;
  }
}

let csrf = '';
export const setCsrf = (t) => { csrf = t; };

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { accept: 'application/json', ...headers } };
  if (method !== 'GET') init.headers['x-somework-csrf'] = csrf;
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
};
