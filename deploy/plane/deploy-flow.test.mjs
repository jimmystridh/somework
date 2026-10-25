// Exercised shell flow with fake executables; NO host or Docker access.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const sha='b'.repeat(40);
function run(args=[],fail='') {
 // /tmp is noexec in the sandbox; fake executables live in this workspace.
 const root=mkdtempSync(join(process.cwd(),'.plane-deploy-flow-'));
 try {
  const bin=join(root,'bin');mkdirSync(bin);
  copyFileSync(new URL('deploy.sh',import.meta.url),join(root,'deploy.sh'));
  writeFileSync(join(root,'plane.env'),'PUBLIC-FIXTURE-NOT-A-SECRET\n');
  const stub=`#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';
const name=basename(process.argv[1]),args=process.argv.slice(2);
appendFileSync(process.env.CALLS,JSON.stringify({name,args})+'\\n');
if(name==='git' && args[0]==='rev-parse') console.log('${sha}');
if(name==='awk') console.log('6000');
if(name==='python3' && process.env.FAIL_STEP==='preflight') process.exit(1);
if(name==='python3' && !args.includes('--check') && process.env.FAIL_STEP==='provision') process.exit(1);
if(name==='docker') {
 if(args[0]==='ps' && args.includes('--filter') && process.env.FAIL_STEP==='aistor') console.log('quay.io/minio/aistor/minio:RELEASE');
 if(args[0]==='wait') console.log(process.env.FAIL_STEP==='migration'?'1':'0');
 if(args.includes('ps') && args.includes('-q')) console.log(args.includes('plane-minio')?'storage-id':'migration-id');
 if(args.includes('up') && args.includes('--wait') && args.includes('plane-minio') && process.env.FAIL_STEP==='layout') process.exit(1);
}
`;
  for(const name of ['git','awk','docker','python3','curl'])writeFileSync(join(bin,name),stub,{mode:0o755});
  const calls=join(root,'calls');
  const r=spawnSync('sh',[join(root,'deploy.sh'),sha,...args],{encoding:'utf8',env:{PATH:`${bin}:${process.env.PATH}`,HOME:root,PLANE_ENV_FILE:join(root,'plane.env'),CALLS:calls,FAIL_STEP:fail}});
  const log=(()=>{try{return readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);}catch{return [];}})();
  return {...r,log};
 } finally {rmSync(root,{recursive:true,force:true});}
}
function compose(r){return r.log.filter(c=>c.name==='docker' && c.args[0]==='compose');}
function starts(r){return compose(r).filter(c=>c.args.includes('up'));}
test('Garage storage-only phase never starts dependencies, migrations or ingress',()=>{
 const r=run(['garage','storage']);assert.equal(r.status,0,r.stderr);
 assert.equal(starts(r).length,1);
 assert.deepEqual(starts(r)[0].args.slice(-4),['up','-d','--no-deps','plane-minio']);
 assert.ok(compose(r).every(c=>c.args.includes('storage/garage/production.compose.yaml')));
 assert.equal(r.log.filter(c=>c.name==='python3').length,1);
 assert.match(r.stdout,/started only/);
});
test('Garage preflight, layout health and provisioning precede migrations',()=>{
 const r=run(['garage']);assert.equal(r.status,0,r.stderr);
 const check=r.log.findIndex(c=>c.name==='python3' && c.args.includes('--check'));
 const health=r.log.findIndex(c=>c.name==='docker' && c.args.includes('up') && c.args.includes('--wait') && c.args.includes('plane-minio'));
 const provision=r.log.findIndex(c=>c.name==='python3' && c.args.includes('storage-id'));
 const migration=r.log.findIndex(c=>c.name==='docker' && c.args.includes('--force-recreate'));
 assert.ok(check>=0 && check<health && health<provision && provision<migration);
 assert.ok(compose(r).every(c=>c.args.includes('storage/garage/production.compose.yaml')));
 const apps=starts(r).filter(c=>!c.args.includes('plane-minio')).map(c=>c.args.at(-1));
 assert.deepEqual(apps,['migrator','api','worker','beat-worker','web','space','admin','live','proxy']);
 const curl=r.log.find(c=>c.name==='curl');
 assert.ok(curl.args.includes('--retry-connrefused'));
 assert.ok(curl.args.includes('--retry-max-time'));
 assert.ok(curl.args.includes('/dev/null'));
});
test('failed preflight, layout, provisioning or migration prevents application startup',()=>{
 for(const failure of ['preflight','layout','provision','migration']){
  const r=run(['garage'],failure);assert.equal(r.status,failure==='migration'?6:failure==='layout'?1:4,failure);
  assert.ok(!starts(r).some(c=>c.args.includes('api')||c.args.includes('proxy')),failure);
  if(failure==='preflight')assert.equal(compose(r).length,0);
  if(['layout','provision'].includes(failure))assert.ok(!starts(r).some(c=>c.args.includes('migrator')));
 }
});
test('default remains licensed AIStor and invalid modes do not mutate containers',()=>{
 const r=run();assert.equal(r.status,4);assert.match(r.stderr,/AIStor license required/);assert.equal(compose(r).length,0);
 for(const args of [['unknown'],['garage','unknown'],['aistor','storage'],['garage','application','extra']]){
  const invalid=run(args);assert.equal(invalid.status,2,invalid.stderr);assert.equal(compose(invalid).length,0);
 }
});
test('Garage refuses to replace an existing AIStor storage container',()=>{
 for(const phase of ['application','storage']){
  const r=run(['garage',phase],'aistor');assert.equal(r.status,4,r.stderr);
  assert.match(r.stderr,/existing AIStor storage/);
  assert.equal(starts(r).length,0);
 }
});
