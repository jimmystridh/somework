import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signed,fixtures} from './s3-smoke.mjs';
test('SigV4 signs host, payload and timestamp with scoped credentials',()=>{
 const t=new Date('2026-10-14T12:30:00Z');
 const h=signed('PUT','http://storage:9000/bucket/key','payload',t);
 assert.equal(h.host,'storage:9000');assert.equal(h['x-amz-date'],'20261014T123000Z');
 assert.equal(h['x-amz-content-sha256'],'239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5');
 assert.match(h.authorization,/Credential=storage-contract-fixture\/20261014\/us-east-1\/s3\/aws4_request/);
 assert.match(h.authorization,/SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
 assert.notEqual(h.authorization,signed('GET','http://storage:9000/bucket/key','',t).authorization);
 assert.notEqual(h.authorization,signed('PUT','http://storage:9000/bucket/key','payload',t,{...fixtures,secret:'different'}).authorization);
 assert.equal(signed('GET','http://storage:9000/b?z=1&a=2','',t).authorization,signed('GET','http://storage:9000/b?a=2&z=1','',t).authorization);
});
