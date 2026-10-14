import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generate} from './generate-secrets.mjs';
const origin='https://admin-cloud-agents.tail371505.ts.net:8443';
test('independent secrets, private modes, correct URLs, never overwrite',()=>{
 const dir=mkdtempSync(join(tmpdir(),'plane-env-test-'));chmodSync(dir,0o700);
 try {
  generate(dir,origin); const content=readFileSync(join(dir,'plane.env'),'utf8');
  const env=Object.fromEntries(content.trimEnd().split('\n').map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));
  const names=['POSTGRES_PASSWORD','RABBITMQ_PASSWORD','SECRET_KEY','LIVE_SERVER_SECRET_KEY','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY'];
  assert.equal(new Set(names.map(n=>env[n])).size,6);
  for(const n of names)assert.match(env[n],/^[a-f0-9]{64}$/);
  assert.equal(env.DATABASE_URL,`postgresql://plane:${env.POSTGRES_PASSWORD}@plane-db/plane`);
  assert.equal(env.AMQP_URL,`amqp://plane:${env.RABBITMQ_PASSWORD}@plane-mq:5672/plane`);
  assert.equal(statSync(join(dir,'plane.env')).mode&0o777,0o600);
  assert.throws(()=>generate(dir,origin),/EEXIST/);
  assert.equal(readFileSync(join(dir,'plane.env'),'utf8'),content);
 }finally{rmSync(dir,{recursive:true});}
});
test('reject broad directory permissions and unreviewed origins',()=>{
 const dir=mkdtempSync(join(tmpdir(),'plane-env-test-'));
 try {
  chmodSync(dir,0o755);assert.throws(()=>generate(dir,origin),/0700/);
  chmodSync(dir,0o700);
  for(const url of ['http://admin-cloud-agents.tail371505.ts.net:8443','https://plane.example.com','https://admin-cloud-agents.tail371505.ts.net:8443/path'])
   assert.throws(()=>generate(dir,url),/reviewed/);
 }finally{rmSync(dir,{recursive:true});}
});
