export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function short(id, n = 8) { return id ? (id.length > n + 6 ? `${id.slice(0, id.indexOf('_') + 1)}…${id.slice(-n)}` : id) : '—'; }

export function chip(text, cls = '', state) { return h('span', { class: `chip ${cls}`, 'data-state': state }, text); }
export function stateChip(state) { return h('span', { class: 'chip', 'data-state': state, 'data-testid': 'state-chip' }, state); }

export function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, 'data-testid': kind === 'error' ? 'toast-error' : 'toast-ok', role: 'alert' }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
}

export function copyButton(text, label = 'copy') {
  return h('button', { class: 'ghost', type: 'button', 'data-testid': 'copy', onClick: async (e) => {
    try { await navigator.clipboard.writeText(text); e.target.textContent = 'copied'; } catch { e.target.textContent = 'copy failed'; }
    setTimeout(() => { e.target.textContent = label; }, 1200);
  } }, label);
}

export function empty(text) { return h('div', { class: 'empty', 'data-testid': 'empty' }, text); }

export function table(columns, rows, opts = {}) {
  if (!rows.length) return empty(opts.empty || 'Nothing here yet.');
  return h('div', { class: 'table-wrap' }, h('table', { 'data-testid': opts.testid || 'table' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', { 'data-testid': opts.rowTestid || 'row', ...(opts.rowAttrs ? opts.rowAttrs(r) : {}) }, columns.map((c) => h('td', {}, c.render(r))))))));
}

export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
}

/** Canonical JSON: sorted keys, no whitespace — matches the server's `canonical_json`. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function jsonView(value, testid = 'json-view') {
  const text = JSON.stringify(value, null, 2);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = esc(text).replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
    let cls = 'n';
    if (/^"/.test(m)) cls = /:$/.test(m) ? 'k' : 's';
    else if (/true|false|null/.test(m)) cls = 'b';
    return `<span class="${cls}">${m}</span>`;
  });
  const pre = h('pre', { class: 'json mono', 'data-testid': testid, tabindex: '0' });
  pre.innerHTML = html;
  return pre;
}

export function tabs(items, active, onSelect) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map(([key, label]) => h('button', { role: 'tab', type: 'button', 'aria-selected': String(key === active), 'data-testid': `tab-${key}`, onClick: () => onSelect(key) }, label)));
}
