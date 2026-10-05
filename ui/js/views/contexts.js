import { get } from '../api.js';
import { chip, clear, fmtTime, h, short, table } from '../dom.js';

export async function render({ root }) {
  const res = await get('/v1/admin/context-packs');
  clear(root).append(
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Context packs'), h('div', { class: 'sub' }, 'Immutable, versioned handover manifests. Imported context is data, never privileged instructions.'))),
    table([
      { label: 'Pack', render: (c) => h('a', { href: `#/canonical/context/${encodeURIComponent(c.contextPackId)}/${c.version}`, 'data-testid': 'context-link' }, `${short(c.contextPackId, 6)} v${c.version}`) },
      { label: 'Objective', render: (c) => c.objective || '—' }, { label: 'Class.', render: (c) => chip(c.classification, 'plain') },
      { label: 'Size', render: (c) => `${c.sizeBytes} B` }, { label: 'Digest', render: (c) => h('span', { class: 'digest' }, c.digest.slice(0, 16) + '…') },
      { label: 'Source task', render: (c) => (c.sourceTaskId ? h('a', { href: `#/tasks/${c.sourceTaskId}` }, short(c.sourceTaskId, 6)) : '—') }, { label: 'Created', render: (c) => fmtTime(c.createdAt) },
    ], res.contextPacks, { testid: 'contexts-table', rowTestid: 'context-row' }));
}
