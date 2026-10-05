import { api, ApiError, get, post, setCsrf } from './api.js';
import { clear, h, toast } from './dom.js';

const ROUTES = [
  ['overview', 'Overview', () => import('./views/overview.js')],
  ['tasks', 'Tasks', () => import('./views/tasks.js')],
  ['conversations', 'Conversations', () => import('./views/conversations.js')],
  ['approvals', 'Approvals', () => import('./views/approvals.js')],
  ['catalog', 'Catalog', () => import('./views/catalog.js')],
  ['policy', 'Policy & audit', () => import('./views/policy.js')],
  ['contexts', 'Context packs', () => import('./views/contexts.js')],
  ['outbox', 'Outbox & health', () => import('./views/outbox.js')],
  ['runtimes', 'Runtimes', () => import('./views/runtimes.js')],
  ['canonical', null, () => import('./views/canonical.js')],
];

const app = document.getElementById('app');
let cleanups = [];
let session = null;
let navCounts = {};

export const onCleanup = (fn) => cleanups.push(fn);
export const getSession = () => session;

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('somework-theme', t); } catch { /* storage unavailable */ }
}
applyTheme((() => { try { return localStorage.getItem('somework-theme'); } catch { return null; } })() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

async function loadSession() {
  const s = await get('/ui/session');
  if (s.authenticated) setCsrf(s.csrf);
  return s.authenticated ? s : null;
}

function loginScreen(cfg, note) {
  const dev = cfg.devTokenLogin && h('form', { 'data-testid': 'dev-login-form', onSubmit: async (e) => {
    e.preventDefault();
    try {
      await post('/ui/dev-login', { token: e.target.token.value });
      location.reload();
    } catch (err) { toast(err.message, 'error'); }
  } }, h('label', {}, 'Bearer token (development only)', h('input', { name: 'token', type: 'password', autocomplete: 'off', 'data-testid': 'dev-token' })), h('button', { type: 'submit', style: 'margin-top:.6rem' }, 'Start session'));
  clear(app).append(h('main', { class: 'login' }, h('div', { class: 'card login-card', 'data-testid': 'login' },
    h('div', { class: 'tag' }, `domain · ${cfg.domainId}`),
    h('h1', {}, 'SomeWork'),
    h('p', { class: 'muted' }, 'Operations & introspection console. Every claim an agent makes is shown next to the platform record that proves — or fails to prove — it.'),
    note && h('p', { class: 'notice-box' }, note),
    cfg.oidcLogin && h('p', {}, h('a', { class: 'btn primary', href: '/ui/login', 'data-testid': 'login-button', style: 'display:inline-block;background:var(--amber);color:#1a1205;padding:.5rem 1.1rem;border-radius:3px;font-weight:600' }, 'Sign in with your identity provider')),
    dev,
    !cfg.oidcLogin && !cfg.devTokenLogin && h('p', { class: 'notice-box' }, 'No login method is configured on this server.'))));
}

function shell(main) {
  const route = currentRoute();
  const nav = ROUTES.filter((r) => r[1]).map(([key, label]) => h('a', { href: `#/${key}`, 'aria-current': route.key === key ? 'page' : null, 'data-testid': `nav-${key}` }, label, navCounts[key] ? h('span', { class: 'count' }, navCounts[key]) : null));
  const theme = document.documentElement.dataset.theme;
  return h('div', { class: 'shell' },
    h('aside', { class: 'rail' },
      h('div', { class: 'brand' }, h('b', {}, 'SomeWork'), h('small', {}, 'console')),
      h('nav', { class: 'nav', 'aria-label': 'Primary' }, nav),
      h('div', { class: 'rail-foot' },
        h('div', { class: 'who', 'data-testid': 'whoami' }, h('div', { class: 'faint' }, session.actor.kind), h('div', { class: 'id' }, session.actor.id), session.roles.length ? h('div', { class: 'chip plain c-plat', style: 'margin-top:.3rem' }, session.roles.join(' · ')) : null),
        h('div', { class: 'row' },
          h('button', { class: 'ghost', type: 'button', 'data-testid': 'theme-toggle', onClick: () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); } }, theme === 'dark' ? 'Light' : 'Dark'),
          h('a', { href: '/metrics', target: '_blank', rel: 'noopener', 'data-testid': 'metrics-link' }, 'metrics'),
          h('button', { class: 'ghost', type: 'button', 'data-testid': 'logout', onClick: async () => { try { await post('/ui/logout'); } finally { location.reload(); } } }, 'Sign out')))),
    h('main', { class: 'main', id: 'main', tabindex: '-1' }, main));
}

export function forbidden(err) {
  return h('div', { class: 'notice-box', 'data-testid': 'forbidden', role: 'alert' },
    h('h2', {}, err.status === 401 ? 'Session required' : 'Not authorised'),
    h('p', {}, err.status === 403 ? 'Your principal has no permission for this operator view. The server refused the request; nothing was disclosed.' : err.message),
    err.traceId ? h('p', { class: 'mono faint' }, `trace ${err.traceId}`) : null);
}

function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { key: parts[0] || 'overview', params: parts.slice(1) };
}

async function refreshNavCounts() {
  if (!session.operator) return;
  try {
    const o = await get('/v1/admin/overview');
    navCounts = { approvals: o.pendingApprovals || '', tasks: '' };
  } catch { navCounts = {}; }
}

async function navigate() {
  cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
  cleanups = [];
  const { key, params } = currentRoute();
  const entry = ROUTES.find((r) => r[0] === key) || ROUTES[0];
  const container = h('div', { 'data-testid': `view-${entry[0]}` });
  clear(app).append(shell(container));
  document.title = `${entry[1] || 'Canonical'} · SomeWork Console`;
  try {
    const mod = await entry[2]();
    await mod.render({ root: container, params, session, onCleanup });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 401)) clear(container).append(forbidden(err));
    else { clear(container).append(h('div', { class: 'notice-box', role: 'alert', 'data-testid': 'view-error' }, err.message)); console.warn(err); }
  }
  refreshNavCounts().then(() => {
    const nav = app.querySelector('.nav');
    const badge = nav?.querySelector('[data-testid="nav-approvals"]');
    if (badge && navCounts.approvals && !badge.querySelector('.count')) badge.append(h('span', { class: 'count', 'data-testid': 'approvals-count' }, navCounts.approvals));
  });
}

async function boot() {
  const cfg = await get('/ui/config.json');
  const params = new URLSearchParams(location.search);
  session = await loadSession();
  if (!session) return loginScreen(cfg, params.get('note'));
  addEventListener('hashchange', navigate);
  navigate();
}

boot().catch((e) => { clear(app).append(h('pre', { class: 'notice-box' }, String(e))); });
export { api };
