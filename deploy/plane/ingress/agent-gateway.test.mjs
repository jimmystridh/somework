import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {agentGateway} from './agent-gateway.mjs';
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = server => new Promise(r => server.close(r));
test('only API-key calls to /api/v1/ pass', async () => {
 let calls = 0;
 const app = http.createServer(async (req, res) => { calls++; let body = ''; for await (const b of req) body += b; res.end(JSON.stringify({url: req.url, body})); });
 const gateway = agentGateway(await listen(app)); const port = await listen(gateway);
 const call = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
 try {
  const key = {'X-API-Key': 'plane_api_test'};
  for (const [path, init] of [['/api/v1/workspaces/w/', {}], ['/', {headers: key}], ['/auth/sign-in/', {headers: key}], ['/api/workspaces/', {headers: key}],
   ['/api/v1/../workspaces/', {headers: key}], ['/api/v1/x/', {method: 'DELETE', headers: key}], ['/api/v1/x/', {method: 'PUT', headers: key}]])
   assert.equal((await call(path, init)).status, 403, `${init.method ?? 'GET'} ${path}`);
  assert.equal(calls, 0);
  const get = await call('/api/v1/workspaces/w/projects/?a=b', {headers: key});
  assert.equal(get.status, 200); assert.equal((await get.json()).url, '/api/v1/workspaces/w/projects/?a=b');
  const post = await call('/api/v1/workspaces/w/issues/', {method: 'POST', body: 'ticket', headers: key});
  assert.equal((await post.json()).body, 'ticket');
 } finally { await close(gateway); await close(app); }
});
test('an unreachable upstream answers 502', async () => {
 const gateway = agentGateway(1); const port = await listen(gateway);
 try { assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/x/`, {headers: {'X-API-Key': 'k'}})).status, 502); } finally { await close(gateway); }
});
