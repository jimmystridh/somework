import { get, qs } from '../api.js';
import { chip, clear, empty, fmtTime, h, kv, short, stateChip, table } from '../dom.js';
import { messageCard } from './tasks.js';

export async function render({ root, params, onCleanup }) {
  if (params[0]) return renderDetail({ root, id: params[0], onCleanup });
  const res = await get('/v1/admin/conversations');
  clear(root).append(
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Conversations'), h('div', { class: 'sub' }, 'Human-readable collaboration history, projected to Matrix rooms and threads.'))),
    table([
      { label: 'Conversation', render: (c) => h('a', { href: `#/conversations/${c.conversationId}`, 'data-testid': 'conversation-link' }, c.title || short(c.conversationId)) },
      { label: 'Kind', render: (c) => chip(c.kind, 'plain') },
      { label: 'Class.', render: (c) => c.classification },
      { label: 'Members', render: (c) => c.members },
      { label: 'Messages', render: (c) => c.messages },
      { label: 'Task', render: (c) => (c.taskId ? h('a', { href: `#/tasks/${c.taskId}` }, short(c.taskId, 6)) : '—') },
      { label: 'Matrix', render: (c) => (c.matrixRoomId ? h('a', { href: `https://matrix.to/#/${encodeURIComponent(c.matrixRoomId)}`, target: '_blank', rel: 'noopener', 'data-testid': 'matrix-link' }, c.matrixRoomId) : h('span', { class: 'faint' }, 'not projected')) },
      { label: 'Created', render: (c) => fmtTime(c.createdAt) },
    ], res.conversations, { testid: 'conversations-table', rowTestid: 'conversation-row', rowAttrs: (c) => ({ 'data-conversation-id': c.conversationId }) }));
}

async function renderDetail({ root, id, onCleanup }) {
  const load = async () => {
    const [conv, msgs, tasks] = await Promise.all([
      get('/v1/admin/conversations').then((r) => r.conversations.find((c) => c.conversationId === id)),
      get(`/v1/admin/messages${qs({ conversationId: id, limit: 500 })}`),
      get(`/v1/admin/tasks${qs({ conversationId: id })}`),
    ]);
    const records = await Promise.all(tasks.tasks.map(async (t) => {
      const [events, audit, decisions] = await Promise.all([
        get(`/v1/tasks/${t.taskId}/events`), get(`/v1/admin/audit${qs({ taskId: t.taskId, limit: 300 })}`), get(`/v1/admin/policy-decisions${qs({ taskId: t.taskId })}`),
      ]);
      return { task: t, events: events.events, audit: audit.events, decisions: decisions.decisions };
    }));
    const left = h('section', { 'aria-label': 'Conversation', 'data-testid': 'conversation-timeline' },
      h('h2', { style: 'margin-bottom:1rem' }, 'What participants said'),
      msgs.messages.length ? msgs.messages.map(messageCard) : empty('No messages.'));
    const right = h('section', { 'aria-label': 'Execution record', 'data-testid': 'execution-record' },
      records.length ? records.map((r) => h('div', { class: 'evidence', style: 'margin-bottom:1.4rem', 'data-testid': 'execution-record-task' },
        h('span', { class: 'stamp' }, 'platform record'),
        h('div', { class: 'row', style: 'margin-bottom:.5rem' }, h('a', { href: `#/tasks/${r.task.taskId}` }, h('strong', {}, `${r.task.capability.id}@${r.task.capability.version}`)), stateChip(r.task.state)),
        h('ol', { class: 'timeline' }, r.events.map((e) => h('li', { 'data-testid': 'execution-event' }, h('strong', {}, e.type.replace(/^task\./, '')), h('div', { class: 't' }, `${fmtTime(e.createdAt)} · ${e.actor?.id || ''}`)))),
        h('p', { class: 'faint' }, `${r.audit.length} audit record(s) · ${r.decisions.length} policy decision(s) — `, h('a', { href: `#/tasks/${r.task.taskId}` }, 'inspect')))) : h('div', { class: 'evidence' }, h('span', { class: 'stamp' }, 'platform record'), h('p', { class: 'muted' }, 'No platform-executed tasks belong to this conversation, so nothing here proves any work happened.')));
    clear(root).append(
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, conv?.title || 'Conversation'), h('div', { class: 'sub row' }, chip(conv?.kind || '', 'plain'), h('span', { class: 'mono' }, id), conv?.matrixRoomId ? h('a', { href: `https://matrix.to/#/${encodeURIComponent(conv.matrixRoomId)}`, target: '_blank', rel: 'noopener', 'data-testid': 'matrix-link' }, 'open in Matrix') : null)), h('a', { href: '#/conversations' }, '← all conversations')),
      h('div', { class: 'split' }, left, right));
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 3000);
  onCleanup(() => clearInterval(t));
}
