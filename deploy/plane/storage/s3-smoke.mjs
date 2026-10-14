// SPDX-License-Identifier: MIT
// Public fixtures ONLY. Isolated, no-published-port storage contract test.
import {createHash,createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const sha = v=>createHash('sha256').update(v).digest('hex');
const hmac = (k,v)=>createHmac('sha256',k).update(v).digest();
const enc = v=>encodeURIComponent(v).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const fixtures = {access:'storage-contract-fixture',secret:'public-storage-contract-fixture-not-for-production'};
export function signed(method, url, body='', now=new Date(), credentials=fixtures) {
 const u=new URL(url); const date=now.toISOString().replace(/[:-]|\.\d{3}/g,'');
 const scope=`${date.slice(0,8)}/us-east-1/s3/aws4_request`;
 const headers={host:u.host,'x-amz-content-sha256':sha(body),'x-amz-date':date};
 const keys=Object.keys(headers).sort();
 const query=[...u.searchParams].map(([k,v])=>[enc(k),enc(v)]).sort(([a,b],[c,d])=>a===c?(b<d?-1:b>d?1:0):(a<c?-1:1)).map(([k,v])=>`${k}=${v}`).join('&');
 const canonical=[method,u.pathname,query,keys.map(k=>`${k}:${headers[k]}\n`).join(''),keys.join(';'),sha(body)].join('\n');
 const key=hmac(hmac(hmac(hmac(`AWS4${credentials.secret}`,date.slice(0,8)),'us-east-1'),'s3'),'aws4_request');
 const signature=createHmac('sha256',key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).digest('hex');
 headers.authorization=`AWS4-HMAC-SHA256 Credential=${credentials.access}/${scope}, SignedHeaders=${keys.join(';')}, Signature=${signature}`;
 return headers;
}
export async function smoke(endpoint, verifyOnly=false) {
 const request=async(method,path,body='',credentials=fixtures)=>fetch(`${endpoint}${path}`,{method,headers:signed(method,`${endpoint}${path}`,body,new Date(),credentials),body:['GET','HEAD'].includes(method)?undefined:body});
 const bucket='/storage-contract-fixture'; const object=`${bucket}/restart-probe.txt`; const data='Plane storage contract: restart persistence\n';
 if (!verifyOnly) {
  const unauth=await fetch(`${endpoint}${bucket}`);assert.equal(unauth.status,403);await unauth.arrayBuffer();
  const create=await request('PUT',bucket);assert.equal(create.status,200);await create.arrayBuffer();
  const put=await request('PUT',object,data);assert.equal(put.status,200);await put.arrayBuffer();
 }
 const get=await request('GET',object);assert.equal(get.status,200);assert.equal(await get.text(),data);
 const bad=await request('GET',object,'',{...fixtures,secret:'invalid-public-test-secret'});assert.equal(bad.status,403);await bad.arrayBuffer();
 const unsigned=await fetch(`${endpoint}${object}`);assert.equal(unsigned.status,403);await unsigned.arrayBuffer();
 // No credentials, signed URLs, object paths or error response bodies in logs.
 console.log(verifyOnly?'storage restart verification passed':'storage write/read/auth contract passed');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {await smoke('http://storage:9000',process.argv.includes('--verify'));}
 catch {console.error('storage contract failed (inspect safely, without rendering credentials)');process.exitCode=1;}
}
