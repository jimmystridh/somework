import { get, post, qs } from '../api.js';
import { ago, chip, clear, copyButton, fmtTime, h, jsonView, kv, short, stateChip, table, tabs, toast, empty } from '../dom.js';

const STATES = ['', 'submitted', 'queued', 'claimed', 'running', 'input_required', 'blocked', 'cancel_requested', 'succeeded', 'failed', 'rejected', 'canceled', 'expired'];

export async function render({ root, params, onCleanup, session }) {
  if (params[0] && params[0] !== 'state') return renderDetail({ root, id: params[0], onCleanup, session });
  return renderList({ root, state: params[0] === 'state' ? params[1] : '', onCleanup });
}

async function renderList({ root, state, onCleanup }) {
  let filter = { state, text: '' };
  const holder = h('div', { 'data-testid': 'tasks-list' });
  const load = async () => {
    const res = await get(`/v1/admin/tasks${qs({ state: filter.state, limit: 100 })}`);
    const text = filter.text.toLowerCase();
    const rows = res.tasks.filter((t) => !text || [t.taskId, t.capability.id, t.requester.id, t.assignee?.id, t.state].filter(Boolean).join(' ').toLowerCase().includes(text));
    clear(holder).append(table([
      { label: 'Task', render: (t) => h('a', { href: `#/tasks/${t.taskId}`, 'data-testid': 'task-link' }, short(t.taskId, 6)) },
      { label: 'State', render: (t) => stateChip(t.state) },
      { label: 'Capability', render: (t) => h('span', { class: 'mono' }, `${t.capability.id}@${t.capability.version}`) },
      { label: 'Requester', render: (t) => t.requester.id },
      { label: 'Assignee', render: (t) => t.assignee?.id || '—' },
      { label: 'Rev', render: (t) => t.revision },
      { label: 'Side effects', render: (t) => chip(t.sideEffects, 'plain') },
      { label: 'Updated', render: (t) => h('span', { title: fmtTime(t.updatedAt) }, ago(t.updatedAt)) },
    ], rows, { testid: 'tasks-table', rowTestid: 'task-row', rowAttrs: (t) => ({ 'data-task-id': t.taskId, 'data-state': t.state }), empty: 'No tasks match.' }));
  };
  clear(root).append(
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Tasks'), h('div', { class: 'sub' }, 'Canonical task records. Click through for the lifecycle, authority and evidence.')),
      h('div', { class: 'row' },
        h('label', {}, 'State', h('select', { 'data-testid': 'filter-state', onChange: (e) => { filter.state = e.target.value; load(); } }, STATES.map((s) => h('option', { value: s, selected: s === state }, s || 'any')))),
        h('label', {}, 'Search', h('input', { type: 'search', 'data-testid': 'filter-text', placeholder: 'id, capability, agent…', onInput: (e) => { filter.text = e.target.value; load(); } })))),
    holder);
  await load();
  const t = setInterval(() => load().catch(() => {}), 3000);
  onCleanup(() => clearInterval(t));
}

function lifecycle(events) {
  return h('ol', { class: 'timeline', 'data-testid': 'lifecycle' }, events.map((e) => h('li', { 'data-testid': 'lifecycle-event', 'data-type': e.type },
    h('div', { class: 'row' }, h('strong', {}, e.type.replace(/^task\./, '')), e.toState ? stateChip(e.toState) : null, h('span', { class: 'chip plain' }, `rev ${e.revision}`)),
    h('div', { class: 't' }, `${fmtTime(e.createdAt)} · ${e.actor?.id || ''}`, e.traceId ? ` · trace ${short(e.traceId, 6)}` : ''),
    e.data && Object.keys(e.data).length ? h('details', {}, h('summary', { class: 'faint' }, 'event data'), jsonView(e.data, 'event-data')) : null)));
}

function actionsBar(task, session, reload) {
  const bar = h('div', { class: 'row', 'data-testid': 'task-actions' });
  const guard = (fn) => async () => { try { await fn(); await reload(); } catch (e) { toast(e.message, 'error'); } };
  if (!task.state || !['succeeded', 'failed', 'rejected', 'canceled', 'expired'].includes(task.state)) {
    bar.append(h('button', { class: 'danger', type: 'button', 'data-testid': 'cancel-task', onClick: guard(async () => { await post(`/v1/tasks/${task.taskId}/cancel`, { reason: 'cancelled from console' }); toast('Cancellation recorded'); }) }, 'Cancel task'));
  }
  if (task.state === 'blocked' && task.blocker?.kind === 'reconciliation') {
    const note = h('input', { placeholder: 'operator note', 'data-testid': 'reconcile-note' });
    const resolution = h('select', { 'data-testid': 'reconcile-resolution' }, ['retry', 'failed', 'canceled', 'succeeded'].map((r) => h('option', { value: r }, r)));
    const result = h('textarea', { rows: 3, placeholder: 'result JSON (required for "succeeded")', 'data-testid': 'reconcile-result' });
    bar.append(h('div', { class: 'card', style: 'width:100%' }, h('h3', {}, 'Reconciliation required'),
      h('p', { class: 'muted' }, `Reason: ${task.blocker.reason}. A worker was lost during a non-repeatable action; an operator must decide the outcome.`),
      h('div', { class: 'row' }, resolution, note, h('button', { class: 'primary', type: 'button', 'data-testid': 'reconcile-submit', onClick: guard(async () => {
        const body = { resolution: resolution.value, note: note.value || undefined };
        if (resolution.value === 'succeeded') body.result = JSON.parse(result.value || '{}');
        await post(`/v1/tasks/${task.taskId}/reconcile`, body);
        toast(`Reconciled as ${resolution.value}`);
      }) }, 'Resolve')), result));
  }
  return bar;
}

async function renderDetail({ root, id, onCleanup, session }) {
  let active = 'overview';
  const body = h('div');
  clear(root).append(body);
  const load = async () => {
    const [task, evs] = await Promise.all([get(`/v1/tasks/${id}`), get(`/v1/tasks/${id}/events`)]);
    const [audit, decisions, messages, artifacts, tree] = await Promise.all([
      get(`/v1/admin/audit${qs({ taskId: id, limit: 500 })}`).catch(() => ({ events: [] })),
      get(`/v1/admin/policy-decisions${qs({ taskId: id })}`).catch(() => ({ decisions: [] })),
      get(`/v1/admin/messages${qs({ taskId: id })}`).catch(() => ({ messages: [] })),
      get(`/v1/admin/artifacts${qs({ taskId: id })}`).catch(() => ({ artifacts: [] })),
      get(`/v1/tasks/${id}/tree`).catch(() => null),
    ]);
    draw(task, evs.events, audit.events, decisions.decisions, messages.messages, artifacts.artifacts, tree);
  };
  const draw = (task, events, audit, decisions, messages, artifacts, tree) => {
    const auth = task.effectiveAuthority;
    const overview = h('div', { class: 'split' },
      h('div', { class: 'grid' },
        h('div', { class: 'card' }, h('h2', {}, 'Record'), kv([
          ['State', stateChip(task.state)], ['Revision', h('span', { 'data-testid': 'task-revision' }, task.revision)], ['Attempt', task.attempt],
          ['Capability', h('span', { class: 'mono' }, `${task.capability.id}@${task.capability.version}`)], ['Side effects', task.sideEffects],
          ['Requester', `${task.requester.kind}:${task.requester.id}`], ['Target', task.targetAgentId], ['Assignee', task.assignee?.id],
          ['Lease', task.lease ? h('span', { class: 'mono', 'data-testid': 'lease' }, `fence ${task.lease.fencingToken} · ${task.lease.runtimeInstanceId} · until ${fmtTime(task.lease.expiresAt)}`) : 'none'],
          ['Created', fmtTime(task.createdAt)], ['Deadline', task.deadlineAt && fmtTime(task.deadlineAt)], ['Conversation', task.conversationId && h('a', { href: `#/conversations/${task.conversationId}` }, short(task.conversationId))],
          ['Parent', task.parentTaskId && h('a', { href: `#/tasks/${task.parentTaskId}` }, short(task.parentTaskId))],
          ['Cancel arrived late', task.cancelLate === true ? 'yes — resolved to completion' : null],
        ])),
        actionsBar(task, session, load),
        task.blocker ? h('div', { class: 'notice-box info', 'data-testid': 'blocker' }, h('strong', {}, 'Blocker'), jsonView(task.blocker, 'blocker-json')) : null,
        task.pendingApproval ? h('div', { class: 'notice-box info', 'data-testid': 'task-pending-approval' }, h('strong', {}, 'Awaiting approval '), h('a', { href: '#/approvals' }, short(task.pendingApproval.approvalId))) : null,
        task.failure ? h('div', { class: 'notice-box', 'data-testid': 'failure' }, h('strong', {}, `Failure: ${task.failure.code}`), h('p', {}, task.failure.message)) : null,
        task.result ? h('div', { class: 'card' }, h('h2', {}, 'Result'), jsonView(task.result, 'result-json')) : null,
        h('div', { class: 'card' }, h('h2', {}, 'Effective authority'), auth ? kv([
          ['Side effects at most', auth.sideEffectsAtMost], ['Classification max', auth.classificationMax], ['Actions', auth.actions.join(', ')],
          ['Delegation', auth.delegationAllowed ? `allowed · ${auth.delegationRemaining} level(s) left` : 'not allowed'], ['Policy version', auth.policyVersion],
        ]) : h('p', { class: 'muted' }, 'Computed at claim time; not yet claimed.')),
        h('div', { class: 'card' }, h('h2', {}, 'Artifacts'), artifacts.length ? table([{ label: 'Artifact', render: (a) => h('span', { class: 'mono' }, `${short(a.artifactId)} v${a.version}`) }, { label: 'File', render: (a) => a.filename || '—' }, { label: 'Status', render: (a) => chip(a.status, 'plain') }, { label: 'Size', render: (a) => a.sizeBytes ?? '—' }, { label: 'SHA-256', render: (a) => h('span', { class: 'digest' }, a.digest ? a.digest.slice(0, 16) + '…' : '—') }], artifacts, { testid: 'artifacts-table' }) : empty('No artifacts.'))),
      h('div', { class: 'evidence', 'data-testid': 'execution-record' }, h('span', { class: 'stamp' }, 'platform record'),
        h('h2', { style: 'margin-bottom:.6rem' }, 'Lifecycle'), lifecycle(events),
        h('p', { class: 'faint', style: 'margin-top:1rem' }, 'Written by the domain service in the same transaction as each state change.')));
    const evidence = h('div', { class: 'evidence', 'data-testid': 'execution-evidence' }, h('span', { class: 'stamp' }, 'platform record'),
      h('h3', {}, 'Policy decisions'), decisions.length ? table([{ label: 'When', render: (d) => fmtTime(d.occurredAt) }, { label: 'Actor', render: (d) => d.actor }, { label: 'Action', render: (d) => d.action }, { label: 'Decision', render: (d) => chip(d.decision, 'plain', d.decision === 'allow' ? 'succeeded' : 'failed') }, { label: 'Reasons', render: (d) => (d.reasons || []).join('; ') || '—' }], decisions, { testid: 'decisions-table', rowTestid: 'decision-row' }) : empty('No decisions recorded.'),
      h('h3', { style: 'margin-top:1rem' }, 'Audit trail'), audit.length ? table([{ label: '#', render: (a) => a.seq }, { label: 'When', render: (a) => fmtTime(a.occurredAt) }, { label: 'Actor', render: (a) => a.authenticatedActor }, { label: 'Action', render: (a) => a.action }, { label: 'Outcome', render: (a) => chip(a.outcome, 'plain', a.outcome === 'success' ? 'succeeded' : 'failed') }, { label: 'Trace', render: (a) => (a.traceId ? h('span', { class: 'row' }, h('span', { class: 'mono' }, short(a.traceId, 6)), copyButton(a.traceId)) : '—') }], audit, { testid: 'audit-table', rowTestid: 'audit-row' }) : empty('No audit records.'));
    const claims = h('div', {}, h('p', { class: 'muted' }, 'Messages exchanged about this task. These are what participants said — not proof that anything happened.'), messages.length ? messages.map(messageCard) : empty('No messages reference this task.'));
    const dag = tree ? h('div', { class: 'card' }, h('h2', {}, 'Delegation lineage'), h('ul', { class: 'dag', 'data-testid': 'dag' }, dagNode(tree, id))) : empty('No lineage available.');
    const canonical = h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('h2', {}, 'Canonical task'), h('a', { href: `#/canonical/task/${task.taskId}`, 'data-testid': 'open-canonical' }, 'open in canonical viewer')), jsonView(task, 'task-json'));
    const panes = { overview, evidence, claims, dag, canonical };
    clear(body).append(
      h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Task ', h('span', { class: 'mono', 'data-testid': 'task-id' }, task.taskId)), h('div', { class: 'sub row' }, stateChip(task.state), h('span', {}, `${task.capability.id}@${task.capability.version}`))), h('a', { href: '#/tasks' }, '← all tasks')),
      tabs([['overview', 'Overview'], ['evidence', 'Execution record'], ['claims', 'Messages'], ['dag', 'DAG'], ['canonical', 'Canonical']], active, (k) => { active = k; draw(task, events, audit, decisions, messages, artifacts, tree); }),
      panes[active]);
  };
  await load();
  const t = setInterval(() => load().catch(() => {}), 1200);
  onCleanup(() => clearInterval(t));
}

const NOTICE_TYPES = new Set(['chat.notice', 'task.status']);
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
    h('div', { class: 'body' }, messageText(m)));
}

function messageText(m) {
  const d = m.content?.data;
  if (typeof d === 'string') return d;
  if (d && typeof d.text === 'string') return d.text;
  return JSON.stringify(d);
}

function dagNode(node, currentId) {
  const t = node.task;
  return h('li', {}, h('a', { class: 'node', href: `#/tasks/${t.taskId}`, 'data-testid': 'dag-node', 'data-state': t.state, 'data-task-id': t.taskId, 'aria-current': t.taskId === currentId ? 'true' : null, style: t.taskId === currentId ? 'border-color:var(--amber)' : '' },
    stateChip(t.state), h('span', { class: 'mono' }, t.capability.id), h('span', { class: 'faint' }, t.assignee?.id || 'unassigned')),
    node.children.length ? h('ul', {}, node.children.map((c) => dagNode(c, currentId))) : null);
}
