import { get, post } from '../api.js';
import { chip, clear, fmtTime, h, short, table, tabs, toast } from '../dom.js';

export async function render({ root }) {
  let status = 'pending';
  const body = h('div');
  clear(root).append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Approvals'), h('div', { class: 'sub' }, 'A decision is bound to the exact action digest and task revision it was requested for. A stale approval is refused by the server.'))), h('button', { type: 'button', class: 'ghost', 'data-testid': 'refresh', onClick: () => load() }, 'Refresh'), body);
  const decide = async (a, decision) => {
    try {
      await post(`/v1/approvals/${a.approvalId}/decision`, { decision, actionDigest: a.actionDigest, taskRevision: a.taskRevision });
      toast(`Approval ${decision}`);
    } catch (e) { toast(e.message, 'error'); }
    await load();
  };
  const load = async () => {
    const res = await get(`/v1/approvals${status === 'all' ? '' : `?status=${status}`}`);
    clear(body).append(
      tabs([['pending', 'Pending'], ['approved', 'Approved'], ['denied', 'Denied'], ['superseded', 'Superseded'], ['all', 'All']], status, (k) => { status = k; load(); }),
      table([
        { label: 'Task', render: (a) => h('a', { href: `#/tasks/${a.taskId}` }, short(a.taskId, 6)) },
        { label: 'Action', render: (a) => h('span', { class: 'mono' }, a.action) },
        { label: 'Task rev', render: (a) => h('span', { 'data-testid': 'approval-revision' }, a.taskRevision) },
        { label: 'Action digest', render: (a) => h('span', { class: 'digest', 'data-testid': 'approval-digest', title: a.actionDigest }, a.actionDigest.slice(0, 20) + '…') },
        { label: 'Status', render: (a) => chip(a.status, 'plain', a.status === 'approved' ? 'succeeded' : a.status === 'pending' ? 'input_required' : a.status === 'denied' ? 'failed' : 'canceled') },
        { label: 'Expires', render: (a) => fmtTime(a.expiresAt) },
        { label: '', render: (a) => (a.status === 'pending' ? h('span', { class: 'row' }, h('button', { class: 'primary', type: 'button', 'data-testid': 'approve', onClick: () => decide(a, 'approved') }, 'Approve'), h('button', { class: 'danger', type: 'button', 'data-testid': 'deny', onClick: () => decide(a, 'denied') }, 'Deny')) : a.approvedBy || '') },
      ], res.approvals, { testid: 'approvals-table', rowTestid: 'approval-row', rowAttrs: (a) => ({ 'data-approval-id': a.approvalId, 'data-task-id': a.taskId, 'data-status': a.status }), empty: 'No approvals in this state.' }));
  };
  await load();
}
