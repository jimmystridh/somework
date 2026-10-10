import { get } from '../api.js';
import { canonicalJson, clear, copyButton, h, jsonView, kv, sha256Hex } from '../dom.js';

export async function render({ root, params }) {
  const [kind, ...rest] = params;
  const id = rest.join('/');
  clear(root).append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, `Canonical ${kind}`), h('div', { class: 'sub mono', 'data-testid': 'canonical-id' }, id)), h('a', { href: 'javascript:history.back()' }, '← back')));
  if (kind === 'message') return message(root, id);
  root.append(h('div', { class: 'notice-box' }, `Unknown canonical kind “${kind}”.`));
}

function digestLine(label, hex, testid) {
  return h('div', { class: 'row' }, h('span', { class: 'faint' }, label), h('span', { class: 'digest', 'data-testid': testid }, hex), copyButton(hex));
}

async function message(root, id) {
  const record = await get(`/v1/messages/${id}`);
  const { seq, traceId, ...envelope } = record;
  root.append(
    h('div', { class: 'notice-box info' }, 'This is the exact stored MessageEnvelope (schema v1). The readable projection in conversations and Matrix is derived from it.'),
    h('div', { class: 'card', style: 'margin-top:1rem' }, kv([
      ['Type', h('span', { 'data-testid': 'envelope-type' }, envelope.type)], ['Trigger mode', h('span', { 'data-testid': 'envelope-trigger' }, envelope.triggerMode)],
      ['Sender', `${envelope.sender.kind}:${envelope.sender.id}`], ['Message id', h('span', { class: 'mono', 'data-testid': 'envelope-id' }, envelope.messageId)],
    ]),
    h('div', { style: 'margin-top:.8rem' }, digestLine('SHA-256 of canonical envelope', await sha256Hex(canonicalJson(envelope)), 'digest-envelope'), digestLine('SHA-256 of content.data', await sha256Hex(canonicalJson(envelope.content.data)), 'digest-content'))),
    h('div', { class: 'card', style: 'margin-top:1rem' }, h('div', { class: 'card-title' }, h('h2', {}, 'MessageEnvelope'), copyButton(JSON.stringify(envelope, null, 2), 'copy JSON')), jsonView(envelope, 'envelope-json')));
}
