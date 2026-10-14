import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const plane=fileURLToPath(new URL('../',import.meta.url));
const dir=`${plane}storage/garage/`;
const bin=process.env.COMPOSE_BIN||'docker';
const prefix=process.env.COMPOSE_BIN?[]:['compose'];
function render(files,env={}){
 const r=spawnSync(bin,[...prefix,'--project-directory',plane,'--env-file','/dev/null',
  ...files.flatMap(f=>['-f',f]),'--profile','test','config','--format','json'],
  {encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,...env}});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('Garage test fixture uses actual pinned Plane boto3 and isolated storage',()=>{
 const c=render([`${dir}test.compose.yaml`]);
 assert.equal(c.networks.isolated.internal,true);
 for(const s of Object.values(c.services)){assert.equal(s.ports,undefined);assert.match(s.image,/@sha256:[a-f0-9]{64}$/);assert.ok(s.mem_limit>0);}
 assert.equal(c.services.storage.image,JSON.parse(readFileSync(`${dir}provenance.json`)).image);
 assert.match(c.services.client.image,/^makeplane\/plane-backend:v1.4.2@/);
 const smoke=readFileSync(`${dir}boto3-contract.py`,'utf8');
 for(const term of ['generate_presigned_post','Content-Disposition','head_object','copy_object','upload_fileobj','--verify','wrong-region','GKaaaaaaaa','put_bucket_acl','put_bucket_policy'])assert.ok(smoke.includes(term),term);
});
test('candidate layer removes licensed runtime mounts and keeps private listeners',()=>{
 const env={WEB_URL:'https://fixture.example',APP_DOMAIN:'fixture.example',DATABASE_URL:'fixture',AMQP_URL:'fixture',
  POSTGRES_PASSWORD:'fixture',RABBITMQ_PASSWORD:'fixture',SECRET_KEY:'fixture',LIVE_SERVER_SECRET_KEY:'fixture',
  AWS_ACCESS_KEY_ID:'fixture',AWS_SECRET_ACCESS_KEY:'fixture',AWS_REGION:'garage',MINIO_LICENSE_FILE:'/unused/minio.license',
  CERT_EMAIL:'',CERT_ACME_CA:'',CERT_ACME_DNS:''};
 const c=render([`${plane}upstream/compose.yaml`,`${plane}compose.yaml`,`${dir}production.compose.yaml`],env);
 const s=c.services['plane-minio'];assert.equal(s.image,JSON.parse(readFileSync(`${dir}provenance.json`)).image);
 assert.deepEqual(s.command,['/garage','server']);assert.deepEqual(s.healthcheck.test,['CMD','/garage','health']);
 assert.equal(s.ports,undefined);assert.deepEqual(s.environment,undefined);
 assert.ok(!s.volumes.some(v=>v.target==='/minio.license'||v.source==='uploads'));
 assert.deepEqual(s.volumes.filter(v=>v.type==='volume').map(v=>v.source).sort(),['garage_meta','garage_objects']);
 assert.ok(s.volumes.filter(v=>v.type==='bind').every(v=>v.read_only && !v.bind.create_host_path));
 // Compose omits unused volumes from rendered config; it does NOT delete them.
 assert.match(readFileSync(`${plane}upstream/compose.yaml`,'utf8'),/uploads:/);
 assert.equal(c.volumes.uploads,undefined);
 assert.equal(c.services.proxy.ports[0].host_ip,'127.0.0.1');
 for(const n of ['api','worker','beat-worker','migrator'])assert.equal(c.services[n].environment.AWS_REGION,'garage');
 const config=readFileSync(`${dir}production.toml`,'utf8');
 assert.match(config,/rpc_bind_addr = "127.0.0.1:3901"/);assert.match(config,/rpc_secret_file =/);
 assert.doesNotMatch(config,/\[admin\]|\[s3_web\]|rpc_secret =/);
 assert.match(config,/s3_region = "garage"/);
});
