import { get, post } from '../api.js';
import { chip, clear, empty, h, toast } from '../dom.js';

export async function render({ root }) {
  const body = h('div', { class: 'grid' });
  clear(root).append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Catalog'), h('div', { class: 'sub' }, 'Logical agents and their capability contracts. Self-registered entries start as drafts until approved.'))), body);
  const act = async (entry, payload) => {
    try { await post(`/v1/agents/${encodeURIComponent(entry.agentCard.agentId)}/approval`, payload); toast(`${entry.agentCard.agentId}: ${payload.status || 'updated'}`); } catch (e) { toast(e.message, 'error'); }
    await load();
  };
  const load = async () => {
    const res = await get('/v1/admin/catalog');
    clear(body).append(...(res.entries.length ? res.entries.map((e) => card(e, act)) : [empty('Catalog is empty.')]));
  };
  await load();
}

function card(e, act) {
  const id = e.agentCard.agentId;
  const exports = h('input', { value: (e.exportedCapabilities || []).join(','), placeholder: 'capability ids', 'data-testid': 'exports-input' });
  const visibility = h('select', { 'data-testid': 'visibility-select' }, ['private', 'domain', 'exported', 'public'].map((v) => h('option', { value: v, selected: v === e.visibility }, v)));
  const tier = h('select', { 'data-testid': 'trust-select' }, ['local', 'partner', 'external', 'untrusted'].map((v) => h('option', { value: v, selected: v === (e.trustTier || 'local') }, v)));
  const status = e.approval.status;
  return h('article', { class: 'card', 'data-testid': 'catalog-entry', 'data-agent-id': id, 'data-approval': status },
    h('div', { class: 'card-title' }, h('h2', {}, e.agentCard.displayName, ' ', h('span', { class: 'mono faint' }, id)), h('span', { class: 'row' }, chip(status, 'plain', status === 'approved' ? 'succeeded' : status === 'draft' ? 'input_required' : 'failed'), chip(e.availability.state, 'plain'), chip(`source: ${e.source.type}`, 'plain'))),
    h('p', { class: 'muted' }, e.agentCard.description),
    h('ul', { style: 'margin:.3rem 0 .8rem;padding-left:1.1rem' }, e.agentCard.capabilities.map((c) => h('li', {}, h('span', { class: 'mono' }, `${c.id}@${c.version}`), ' ', chip(c.sideEffects, 'plain', c.sideEffects === 'irreversible' ? 'failed' : c.sideEffects === 'write' ? 'input_required' : 'queued'), ' ', h('span', { class: 'faint' }, c.description)))),
    h('div', { class: 'row' }, h('label', {}, 'Visibility', visibility), h('label', {}, 'Trust tier', tier), h('label', {}, 'Exported capabilities', exports),
      h('button', { class: 'primary', type: 'button', 'data-testid': 'approve-entry', disabled: status === 'revoked', onClick: () => act(e, { status: 'approved', visibility: visibility.value, trustTier: tier.value, exportedCapabilities: exports.value.split(',').map((s) => s.trim()).filter(Boolean) }) }, status === 'approved' ? 'Update' : 'Approve'),
      h('button', { type: 'button', 'data-testid': 'suspend-entry', disabled: status !== 'approved', onClick: () => act(e, { status: 'suspended' }) }, 'Suspend'),
      h('button', { class: 'danger', type: 'button', 'data-testid': 'revoke-entry', disabled: status === 'revoked', onClick: () => act(e, { status: 'revoked' }) }, 'Revoke')));
}
