import { get } from '../api.js';
import { ago, chip, clear, fmtTime, h, table } from '../dom.js';

export async function render({ root, onCleanup }) {
  const body = h('div', { class: 'grid' });
  clear(root).append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Runtimes & agents'), h('div', { class: 'sub' }, 'A logical agent is stable; each running process is a distinct runtime instance.'))), body);
  const load = async () => {
    const [rt, cat] = await Promise.all([get('/v1/runtimes'), get('/v1/admin/catalog')]);
    const byAgent = new Map();
    rt.runtimes.forEach((r) => byAgent.set(r.agentId, [...(byAgent.get(r.agentId) || []), r]));
    clear(body).append(
      h('div', { class: 'card' }, h('h2', {}, 'Logical agents'), table([
        { label: 'Agent', render: (e) => h('span', { class: 'mono' }, e.agentCard.agentId) }, { label: 'Approval', render: (e) => chip(e.approval.status, 'plain') },
        { label: 'Availability', render: (e) => chip(e.availability.state, 'plain') }, { label: 'Live instances', render: (e) => e.availability.activeInstances ?? 0 }, { label: 'Queue depth', render: (e) => e.availability.queueDepth ?? 0 },
        { label: 'Capabilities', render: (e) => e.agentCard.capabilities.map((c) => c.id).join(', ') },
      ], cat.entries, { testid: 'agents-table', rowTestid: 'agent-row' })),
      h('div', { class: 'card' }, h('h2', {}, 'Runtime instances'), table([
        { label: 'Instance', render: (r) => h('span', { class: 'mono' }, r.runtimeInstanceId) }, { label: 'Agent', render: (r) => r.agentId }, { label: 'Status', render: (r) => chip(r.status, 'plain', r.status === 'active' ? 'succeeded' : 'canceled') },
        { label: 'Started', render: (r) => fmtTime(r.startedAt) }, { label: 'Last seen', render: (r) => ago(r.lastSeenAt) },
      ], rt.runtimes, { testid: 'runtimes-table', rowTestid: 'runtime-row' })));
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 5000);
  onCleanup(() => clearInterval(t));
}
