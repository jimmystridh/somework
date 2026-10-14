import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {gateway} from './gateway.mjs';
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = server => new Promise(r => server.close(r));
const owner = 'test-owner@example.com';
test('owner-only HTTP passes streaming requests and strips identity/spoofed origin', async () => {
 let calls = 0;
 const app = http.createServer(async (req, res) => {
  calls++; let body = ''; for await (const b of req) body += b;
  res.end(JSON.stringify({url:req.url, headers:req.headers, body}));
 });
 const proxy = gateway(owner, await listen(app)); const port = await listen(proxy);
 try {
  for (const h of [{}, {'Tailscale-User-Login':'other@example.com'}, {'Tailscale-User-Login':[owner, owner]}]) {
   const response = await new Promise(r => http.get({host:'127.0.0.1',port,headers:h}, res => {res.resume();r(res.statusCode);}));
   assert.equal(response,403);
  }
  assert.equal(calls,0);
  const res = await fetch(`http://127.0.0.1:${port}/api/uploads/?a=b`, {method:'POST',body:'object',headers:{
   'Tailscale-User-Login':owner,'Tailscale-User-Name':'Owner','X-Forwarded-Proto':'http','X-Forwarded-Host':'attacker'}});
  assert.equal(res.status,200); const body = await res.json();
  assert.equal(body.url,'/api/uploads/?a=b'); assert.equal(body.body,'object');
  assert.equal(body.headers['tailscale-user-login'],undefined);
  assert.equal(body.headers['tailscale-user-name'],undefined);
  assert.equal(body.headers['x-forwarded-proto'],'https');
  assert.equal(body.headers['x-forwarded-host'],`127.0.0.1:${port}`);
 } finally { await close(proxy); await close(app); }
});
test('missing owner configuration fails closed', () => {assert.throws(()=>gateway(''));});
test('websocket upgrades enforce owner and relay both directions', async () => {
 const app = http.createServer(); let calls = 0; const sockets = new Set();
 app.on('connection', s => {sockets.add(s);s.on('close',()=>sockets.delete(s));});
 app.on('upgrade', (req,socket,head) => {
  calls++; socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  if(head.length) socket.write(head); socket.on('data',b=>socket.write(b));
 });
 const proxy = gateway(owner, await listen(app)); const port = await listen(proxy);
 async function exchange(identity, expected) {
  await new Promise((resolve,reject) => {
   const s = net.connect(port,'127.0.0.1'); let buf=''; let sent=false;
   s.setTimeout(2000,()=>{s.destroy();reject(new Error('upgrade timed out'));});
   s.on('error',reject); s.on('connect',()=>s.write(`GET /live/ HTTP/1.1\r\nHost: example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${identity ? `Tailscale-User-Login: ${identity}\r\n` : ''}\r\n`));
   s.on('data',b=>{
    buf+=b.toString();
    if(expected===403 && buf.includes('403 Forbidden')) {s.destroy();resolve();}
    if(expected===101 && buf.includes('\r\n\r\n') && !sent) {sent=true;s.write('echo-marker');}
    if(expected===101 && buf.includes('echo-marker')) {assert.match(buf,/101 Switching/);s.destroy();resolve();}
   });
  });
 }
 try {await exchange(null,403);assert.equal(calls,0);await exchange(owner,101);assert.equal(calls,1);}
 finally {for(const s of sockets) s.destroy();proxy.closeAllConnections();app.closeAllConnections();await close(proxy);await close(app);}
});
