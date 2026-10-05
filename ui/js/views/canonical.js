import { get } from '../api.js';
import { canonicalJson, chip, clear, copyButton, h, jsonView, kv, sha256Hex, table } from '../dom.js';

const SECTIONS = ['objective', 'acceptanceCriteria', 'currentState', 'facts', 'hypotheses', 'decisions', 'openQuestions', 'workspace', 'evidence', 'artifacts', 'requestedContinuation', 'executionConstraints', 'security', 'provenance'];

export async function render({ root, params }) {
  const [kind, ...rest] = params;
  const id = rest.join('/');
  clear(root).append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, `Canonical ${kind}`), h('div', { class: 'sub mono', 'data-testid': 'canonical-id' }, id)), h('a', { href: 'javascript:history.back()' }, '← back')));
  if (kind === 'message') return message(root, id);
  if (kind === 'task') return task(root, id);
  if (kind === 'context') return context(root, rest[0], rest[1]);
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

async function task(root, id) {
  const t = await get(`/v1/tasks/${id}`);
  const { traceId, ...rest } = t;
  root.append(h('div', { class: 'card' }, digestLine('SHA-256 of canonical task', await sha256Hex(canonicalJson(rest)), 'digest-task')), h('div', { class: 'card', style: 'margin-top:1rem' }, h('h2', {}, 'Task'), jsonView(rest, 'task-json')));
}

async function context(root, id, version) {
  const [manifest, view] = await Promise.all([
    get(`/v1/admin/context-packs/${encodeURIComponent(id)}/${version}`),
    get(`/v1/context-packs/${encodeURIComponent(id)}/${version}?sections=${SECTIONS.join(',')}`),
  ]);
  const pack = manifest.manifest;
  const { digest, ...bare } = pack;
  const recomputed = await sha256Hex(canonicalJson(bare));
  const ok = recomputed === digest;
  root.append(
    h('div', { class: ok ? 'notice-box info' : 'notice-box', 'data-testid': 'digest-verdict', 'data-ok': String(ok) }, ok ? 'Digest verified in the browser: the manifest hashes to its recorded SHA-256.' : 'Digest mismatch: the stored manifest does not hash to its recorded digest.'),
    h('div', { class: 'card', style: 'margin-top:1rem' }, digestLine('Recorded digest', digest, 'digest-recorded'), digestLine('Recomputed digest', recomputed, 'digest-recomputed'),
      kv([['Classification', pack.security.classification], ['Allowed domains', pack.security.allowedDomains.join(', ')], ['Instructions trusted', String(pack.security.instructionsTrusted)], ['Continuation', pack.requestedContinuation.mode]])),
    h('div', { class: 'card', style: 'margin-top:1rem' }, h('h2', {}, 'Section index & disclosure'), table([{ label: 'Section', render: (r) => r[0] }, { label: 'Present', render: (r) => (r[1].present ? 'yes' : 'no') }, { label: 'Bytes', render: (r) => r[1].bytes }, { label: 'Disclosed to you', render: (r) => chip(r[1].disclosed ? 'yes' : 'withheld', 'plain', r[1].disclosed ? 'succeeded' : 'failed') }], Object.entries(view.sectionIndex), { testid: 'section-index', rowTestid: 'section-row' })),
    h('div', { class: 'card', style: 'margin-top:1rem' }, h('div', { class: 'card-title' }, h('h2', {}, 'ContextPack'), copyButton(JSON.stringify(pack, null, 2), 'copy JSON')), jsonView(pack, 'context-json')));
}
