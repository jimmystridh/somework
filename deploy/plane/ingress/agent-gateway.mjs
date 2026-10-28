// SPDX-License-Identifier: MIT
// Agent-facing Plane access: only the public API (`/api/v1/`) with an API key, so
// agents never reach the web UI, sign-in or the internal API. Bind to the private
// agent network address, never a public one; Plane checks the key itself.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
const METHODS = new Set(['GET', 'POST', 'PATCH']);
export function agentGateway(upstreamPort = 18090) {
 const allowed = req => METHODS.has(req.method) && req.url.startsWith('/api/v1/') && !req.url.includes('..')
  && typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'] !== '';
 return http.createServer((req, res) => {
  if (!allowed(req)) { res.writeHead(403); res.end('Forbidden\n'); return; }
  const proxy = http.request({host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers});
  proxy.on('response', reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); reply.on('error', () => res.destroy()); });
  proxy.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Gateway unavailable\n'); } else res.destroy(); });
  res.on('close', () => proxy.destroy());
  req.pipe(proxy);
 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const bind = process.env.PLANE_AGENT_BIND;
 if (!bind) throw new Error('PLANE_AGENT_BIND (the private agent network address) is required');
 agentGateway().listen(18092, bind);
}
