import { get, qs } from '../api.js';
import { chip, clear, copyButton, empty, fmtTime, h, jsonView, short, table, tabs, toast } from '../dom.js';

export async function render({ root, params }) {
  let active = params[0] || 'decisions';
  const body = h('div');
  clear(root).append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Policy & audit'), h('div', { class: 'sub' }, 'Every privileged mutation maps to an actor, a policy decision and a trace.'))), body);
  const draw = async () => {
    clear(body).append(tabs([['decisions', 'Policy decisions'], ['audit', 'Audit trail'], ['policy', 'Active policy']], active, (k) => { active = k; draw(); }));
    const pane = h('div');
    body.append(pane);
    if (active === 'decisions') await decisions(pane);
    else if (active === 'audit') await audit(pane);
    else pane.append(h('div', { class: 'card' }, jsonView(await get('/v1/admin/policy'), 'policy-json')));
  };
  await draw();
}

async function decisions(pane) {
  let filter = { decision: '', actor: '' };
  const holder = h('div');
  const load = async () => {
    const res = await get(`/v1/admin/policy-decisions${qs({ decision: filter.decision, actor: filter.actor, limit: 300 })}`);
    clear(holder).append(table([
      { label: 'When', render: (d) => fmtTime(d.occurredAt) }, { label: 'Actor', render: (d) => d.actor }, { label: 'Action', render: (d) => d.action },
      { label: 'Resource', render: (d) => h('span', { class: 'mono' }, d.resource || '—') },
      { label: 'Decision', render: (d) => chip(d.decision, 'plain', d.decision === 'allow' ? 'succeeded' : 'failed') },
      { label: 'Reasons', render: (d) => (d.reasons || []).join('; ') || '—' }, { label: 'Policy', render: (d) => d.policyVersion },
      { label: 'Task', render: (d) => (d.taskId ? h('a', { href: `#/tasks/${d.taskId}` }, short(d.taskId, 6)) : '—') },
    ], res.decisions, { testid: 'decisions-table', rowTestid: 'decision-row', rowAttrs: (d) => ({ 'data-decision': d.decision }) }));
  };
  pane.append(h('div', { class: 'row', style: 'margin-bottom:1rem' },
    h('label', {}, 'Decision', h('select', { 'data-testid': 'decision-filter', onChange: (e) => { filter.decision = e.target.value; load(); } }, ['', 'allow', 'deny'].map((v) => h('option', { value: v }, v || 'any')))),
    h('label', {}, 'Actor contains', h('input', { 'data-testid': 'actor-filter', onInput: (e) => { filter.actor = e.target.value; load(); } }))), holder);
  await load();
}

async function audit(pane) {
  const verdict = h('div', { 'data-testid': 'chain-verdict' });
  const holder = h('div');
  pane.append(h('div', { class: 'row', style: 'margin-bottom:1rem' }, h('button', { class: 'primary', type: 'button', 'data-testid': 'verify-chain', onClick: async () => {
    try {
      const r = await get('/v1/admin/audit/verify');
      clear(verdict).append(h('div', { class: r.intact ? 'notice-box info' : 'notice-box', 'data-intact': String(r.intact) }, r.intact ? 'Hash chain intact: every audit record links to its predecessor and recomputes to its recorded hash.' : `Chain broken at record #${r.firstBrokenSeq}.`));
    } catch (e) { toast(e.message, 'error'); }
  } }, 'Verify hash chain')), verdict, holder);
  const res = await get(`/v1/admin/audit${qs({ limit: 500 })}`);
  clear(holder).append(table([
    { label: '#', render: (a) => a.seq }, { label: 'When', render: (a) => fmtTime(a.occurredAt) }, { label: 'Actor', render: (a) => a.authenticatedActor }, { label: 'Action', render: (a) => a.action },
    { label: 'Resource', render: (a) => h('span', { class: 'mono' }, a.resource || '—') }, { label: 'Outcome', render: (a) => chip(a.outcome, 'plain', a.outcome === 'success' ? 'succeeded' : 'failed') },
    { label: 'Transport', render: (a) => a.sourceTransport || '—' },
    { label: 'Trace', render: (a) => (a.traceId ? h('span', { class: 'row' }, h('span', { class: 'mono' }, short(a.traceId, 6)), copyButton(a.traceId)) : '—') },
    { label: 'Hash', render: (a) => h('span', { class: 'digest' }, a.hash.slice(0, 12) + '…') },
  ], res.events, { testid: 'audit-table', rowTestid: 'audit-row' }));
}
