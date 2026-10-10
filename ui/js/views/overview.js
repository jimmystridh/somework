import { get } from '../api.js';
import { chip, clear, empty, h, table } from '../dom.js';

function stat(label, value, cls = '', testid) {
  return h('div', { class: `card stat ${cls}`, 'data-testid': testid }, h('div', { class: 'n', 'data-testid': `${testid}-value` }, String(value ?? 0)), h('div', { class: 'l' }, label));
}

export async function render({ root, onCleanup }) {
  const draw = async () => {
    const o = await get('/v1/admin/overview');
    const sinks = o.outbox || [];
    clear(root).append(
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Overview'), h('div', { class: 'sub' }, `Domain ${o.domainId} · policy ${o.policyVersion}`)),
        h('div', { class: 'row' }, chip(`matrix: ${o.matrixProfile}`, 'plain c-plat'), chip(`objects: ${o.objectStore}`, 'plain c-plat'))),
      h('section', { class: 'grid cols-3', 'aria-label': 'Key figures' },
        stat('Agents', o.agents, '', 'stat-agents'),
        stat('Online runtimes', o.onlineRuntimes, '', 'stat-runtimes'),
        stat('Policy denials · 24h', o.denialsLast24h, o.denialsLast24h ? 'warn' : '', 'stat-denials'),
        stat('Draft catalog entries', o.draftCatalogEntries, o.draftCatalogEntries ? 'attn' : '', 'stat-drafts')),
      h('section', { class: 'grid', style: 'margin-top:1rem' },
        h('div', { class: 'card' }, h('h2', {}, 'Planes'),
          sinks.length ? table(
            [{ label: 'Sink', render: (r) => r.sink }, { label: 'Pending', render: (r) => r.pending + r.failed }, { label: 'Oldest', render: (r) => `${r.oldestPendingAgeSeconds}s` }, { label: 'Dead', render: (r) => (r.dead ? h('span', { class: 'chip c-bad' }, r.dead) : 0) }, { label: 'Published', render: (r) => r.published }],
            sinks, { testid: 'planes-table', rowTestid: 'plane-row', rowAttrs: (r) => ({ 'data-sink': r.sink }) },
          ) : empty('No outbox sinks configured (poll-only deployment).'))));
  };
  await draw();
  const t = setInterval(() => draw().catch(() => {}), 4000);
  onCleanup(() => clearInterval(t));
}
