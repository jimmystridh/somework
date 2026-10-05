import { get, post } from '../api.js';
import { chip, clear, h, table, toast } from '../dom.js';

export async function render({ root, onCleanup }) {
  const body = h('div');
  clear(root).append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Outbox & health'), h('div', { class: 'sub' }, 'Transactional outbox per sink. Dead-lettered rows can be re-queued once the sink is healthy.'))), body);
  const load = async () => {
    const [o, ready] = await Promise.all([get('/v1/admin/outbox'), fetch('/readyz').then((r) => r.json())]);
    clear(body).append(
      h('div', { class: 'card', 'data-testid': 'health' }, h('h2', {}, 'Readiness'), h('div', { class: 'row' }, chip(`database ${ready.database ? 'ok' : 'down'}`, 'plain', ready.database ? 'succeeded' : 'failed'), chip(`object store ${ready.objectStore ? 'ok' : 'down'}`, 'plain', ready.objectStore ? 'succeeded' : 'failed'), h('a', { href: '/metrics', target: '_blank', rel: 'noopener' }, 'Prometheus metrics'))),
      h('div', { class: 'card', style: 'margin-top:1rem' }, h('h2', {}, 'Sinks'), table([
        { label: 'Sink', render: (s) => s.sink }, { label: 'Pending', render: (s) => s.pending }, { label: 'Retrying', render: (s) => s.failed }, { label: 'Oldest', render: (s) => `${s.oldestPendingAgeSeconds}s` },
        { label: 'Dead-lettered', render: (s) => (s.dead ? chip(s.dead, 'plain', 'failed') : 0) }, { label: 'Published', render: (s) => s.published },
        { label: '', render: (s) => (s.dead ? h('button', { type: 'button', 'data-testid': 'requeue-dead', onClick: async () => { try { const r = await post('/v1/admin/outbox/requeue', { sink: s.sink }); toast(`Re-queued ${r.requeued} row(s)`); await load(); } catch (e) { toast(e.message, 'error'); } } }, 'Re-queue dead') : ''), },
      ], o.sinks, { testid: 'outbox-table', empty: 'No sinks configured.' })));
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 4000);
  onCleanup(() => clearInterval(t));
}
