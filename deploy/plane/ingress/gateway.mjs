// SPDX-License-Identifier: MIT
// Tailscale Serve removes caller-supplied identity headers. Trust ONLY loopback
// Serve traffic on a trusted gateway host, never a public/private-IP listener.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
export function gateway(owner, upstreamPort = 18090) {
 if (!owner || /[\r\n]/.test(owner)) throw new Error('explicit owner login required');
 const authorized = req => {
  const identities = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'tailscale-user-login');
  return identities.length === 1 && req.headers['tailscale-user-login'] === owner;
 };
 const headers = req => {
  const h = {...req.headers};
  for (const k of Object.keys(h)) if (/^(tailscale-|x-forwarded-)/.test(k)) delete h[k];
  h['x-forwarded-proto'] = 'https';
  h['x-forwarded-host'] = req.headers.host;
  return h;
 };
 const request = req => http.request({host: '127.0.0.1', port: upstreamPort,
  method: req.method, path: req.url, headers: headers(req)});
 const server = http.createServer((req, res) => {
  if (!authorized(req)) { res.writeHead(403); res.end('Forbidden\n'); return; }
  const proxy = request(req);
  proxy.on('response', reply => {
   res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
   reply.on('error', () => res.destroy());
  });
  proxy.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Gateway unavailable\n'); } else res.destroy(); });
  req.on('aborted', () => proxy.destroy());
  res.on('close', () => proxy.destroy());
  req.pipe(proxy);
 });
 server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
  const proxy = request(req);
  proxy.on('upgrade', (reply, remote, remoteHead) => {
   socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([k,v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
   if (head.length) remote.write(head);
   if (remoteHead.length) socket.write(remoteHead);
   remote.pipe(socket); socket.pipe(remote);
   remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
   socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
  });
  proxy.on('response', reply => { reply.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  proxy.on('error', () => socket.destroy());
  socket.on('close', () => proxy.destroy());
  proxy.end();
 });
 return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 gateway(process.env.PLANE_OWNER_LOGIN).listen(18091, '127.0.0.1');
}
