import { get, qs } from '../api.js';
import { chip, clear, empty, fmtTime, h, short, table } from '../dom.js';
import { messageCard } from './messages.js';

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
      { label: 'Matrix', render: (c) => (c.matrixRoomId ? h('a', { href: `https://matrix.to/#/${encodeURIComponent(c.matrixRoomId)}`, target: '_blank', rel: 'noopener', 'data-testid': 'matrix-link' }, c.matrixRoomId) : h('span', { class: 'faint' }, 'not projected')) },
      { label: 'Created', render: (c) => fmtTime(c.createdAt) },
    ], res.conversations, { testid: 'conversations-table', rowTestid: 'conversation-row', rowAttrs: (c) => ({ 'data-conversation-id': c.conversationId }) }));
}

async function renderDetail({ root, id, onCleanup }) {
  const load = async () => {
    const [conv, msgs, audit] = await Promise.all([
      get('/v1/admin/conversations').then((r) => r.conversations.find((c) => c.conversationId === id)),
      get(`/v1/admin/messages${qs({ conversationId: id, limit: 500 })}`),
      get(`/v1/admin/audit${qs({ limit: 500 })}`),
    ]);
    const records = audit.events.filter((a) => a.conversationId === id);
    const left = h('section', { 'aria-label': 'Conversation', 'data-testid': 'conversation-timeline' },
      h('h2', { style: 'margin-bottom:1rem' }, 'What participants said'),
      msgs.messages.length ? msgs.messages.map(messageCard) : empty('No messages.'));
    const right = h('section', { 'aria-label': 'Platform record', 'data-testid': 'execution-record' },
      h('div', { class: 'evidence', style: 'margin-bottom:1.4rem' },
        h('span', { class: 'stamp' }, 'platform record'),
        records.length ? h('ol', { class: 'timeline' }, records.map((a) => h('li', { 'data-testid': 'execution-event' }, h('strong', {}, a.action), h('div', { class: 't' }, `${fmtTime(a.occurredAt)} · ${a.authenticatedActor || ''} · ${a.outcome}`)))) : h('p', { class: 'muted' }, 'The platform recorded nothing for this conversation.')));
    clear(root).append(
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, conv?.title || 'Conversation'), h('div', { class: 'sub row' }, chip(conv?.kind || '', 'plain'), h('span', { class: 'mono' }, id), conv?.matrixRoomId ? h('a', { href: `https://matrix.to/#/${encodeURIComponent(conv.matrixRoomId)}`, target: '_blank', rel: 'noopener', 'data-testid': 'matrix-link' }, 'open in Matrix') : null)), h('a', { href: '#/conversations' }, '← all conversations')),
      h('div', { class: 'split' }, left, right));
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 3000);
  onCleanup(() => clearInterval(t));
}
