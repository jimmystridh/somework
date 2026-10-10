import { fmtTime, h } from '../dom.js';

const NOTICE_TYPES = new Set(['chat.notice']);
const PARTICIPANT_TYPES = new Set(['chat.message', 'event.notification']);

/** A message is something a participant *said* (a claim), an automated notice, or a projection of platform state. */
export function messageKind(type) {
  if (NOTICE_TYPES.has(type)) return ['notice', 'automated notice'];
  if (PARTICIPANT_TYPES.has(type)) return ['claim', 'reported by participant'];
  return ['projection', 'platform projection'];
}

export function messageCard(m) {
  const [kind, label] = messageKind(m.type);
  return h('article', { class: `claim ${kind === 'notice' ? 'notice' : ''} ${kind === 'projection' ? 'projection' : ''}`, 'data-testid': 'message-card', 'data-type': m.type, 'data-kind': kind, 'data-message-id': m.messageId },
    h('span', { class: 'stamp', 'data-testid': 'message-stamp' }, label),
    h('div', { class: 'meta' }, h('span', { class: 'chip plain', 'data-testid': 'type-badge' }, m.type), h('span', {}, `${m.sender.kind}:${m.sender.id}`), h('span', {}, fmtTime(m.createdAt)), h('span', { 'data-testid': 'trigger-mode' }, `trigger: ${m.triggerMode}`), h('a', { href: `#/canonical/message/${m.messageId}`, 'data-testid': 'message-canonical' }, 'canonical')),
    h('div', { class: 'body' }, messageText(m)),
    m.artifacts?.length ? h('ul', { class: 'attachments', 'data-testid': 'message-attachments' }, m.artifacts.map((a) => h('li', { 'data-testid': 'attachment', 'data-artifact-id': a.artifactId }, h('span', { class: 'mono' }, a.filename || a.artifactId), ' ', h('span', { class: 'faint' }, `${a.mediaType || ''} · ${a.sizeBytes ?? '?'} bytes`)))) : null);
}

function messageText(m) {
  const d = m.content?.data;
  if (typeof d === 'string') return d;
  if (d && typeof d.text === 'string') return d.text;
  return JSON.stringify(d);
}
