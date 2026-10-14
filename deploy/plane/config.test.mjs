import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const bin = process.env.COMPOSE_BIN || 'docker';
const prefix = process.env.COMPOSE_BIN ? [] : ['compose'];
// Deliberately public test fixtures; never used on a host.
const fixtures = {
  WEB_URL: 'https://plane.example.ts.net', APP_DOMAIN: 'plane.example.ts.net',
  DATABASE_URL: 'postgresql://plane:test-fixture-only@plane-db/plane',
  AMQP_URL: 'amqp://plane:test-fixture-only@plane-mq:5672/plane',
  POSTGRES_PASSWORD: 'test-fixture-only', RABBITMQ_PASSWORD: 'test-fixture-only',
  SECRET_KEY: 'test-fixture-only', LIVE_SERVER_SECRET_KEY: 'test-fixture-only',
  AWS_ACCESS_KEY_ID: 'test-fixture-only', AWS_SECRET_ACCESS_KEY: 'test-fixture-only',
  MINIO_LICENSE_FILE: '/test-fixture-only/minio.license',
  CERT_EMAIL: '', CERT_ACME_CA: '', CERT_ACME_DNS: '',
};
function render(vars = fixtures) {
  return spawnSync(bin, [...prefix, '--project-directory', dir, '--env-file', '/dev/null',
    '-f', `${dir}upstream/compose.yaml`, '-f', `${dir}compose.yaml`, 'config', '--format', 'json'],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...vars }, encoding: 'utf8' });
}

test('vendored compose matches v1.4.2 upstream', () => {
  assert.equal(createHash('sha256').update(readFileSync(`${dir}upstream/compose.yaml`)).digest('hex'),
    'ce2dc6829df5a31c482f8a29ad339ef4a26a9cc213e201ad6823d5e0f93f832b');
});
test('application digests match their verified repository identities', () => {
  const evidence = JSON.parse(readFileSync(`${dir}images.json`));
  assert.equal(evidence.release, 'v1.4.2');
  assert.equal(evidence.platform, 'linux/amd64');
  assert.deepEqual(Object.keys(evidence.images).sort(),
    ['web', 'space', 'admin', 'live', 'api', 'worker', 'beat-worker', 'migrator', 'proxy'].sort());
  const result = render();
  assert.equal(result.status, 0, result.stderr);
  const cfg = JSON.parse(result.stdout);
  for (const [service, image] of Object.entries(evidence.images)) {
    assert.equal(cfg.services[service].image, image, service);
    assert.equal(cfg.services[service].platform, evidence.platform, service);
    assert.match(image, /^makeplane\/plane-[a-z]+:v1\.4\.2@sha256:[a-f0-9]{64}$/);
  }
  // A valid digest from a DIFFERENT repository is not a usable image pin.
  assert.equal(new Set(Object.values(evidence.images)).size, 6);
});
test('merged compose has only loopback ingress and persistent volumes', () => {
  const result = render();
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const cfg = JSON.parse(result.stdout);
  assert.equal(cfg.name, 'plane');
  const ports = Object.entries(cfg.services).flatMap(([name, svc]) => (svc.ports || []).map(p => ({ name, ...p })));
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, 'proxy');
  assert.equal(ports[0].host_ip, '127.0.0.1');
  assert.equal(String(ports[0].published), '8090');
  assert.equal(ports[0].target, 80);
  for (const [name, svc] of Object.entries(cfg.services)) {
    assert.equal(svc.restart, name === 'migrator' ? 'on-failure' : 'unless-stopped');
    assert.ok(svc.mem_limit > 0, name);
    assert.ok(!/:latest|:stable/.test(svc.image), name);
    assert.ok(svc.image.includes('@sha256:') || /:\d+\.\d+/.test(svc.image), name);
    assert.ok(!svc.privileged);
    assert.ok(!svc.network_mode);
  }
  for (const [name, volume, target] of [
    ['plane-db', 'pgdata', '/var/lib/postgresql/data'],
    ['plane-minio', 'uploads', '/export'],
    ['plane-redis', 'redisdata', '/data'],
    ['plane-mq', 'rabbitmq_data', '/var/lib/rabbitmq'],
  ]) {
    assert.ok(cfg.services[name].volumes.some(v => v.type === 'volume' && v.source === volume && v.target === target));
    assert.equal(cfg.volumes[volume].name, `plane_${volume}`);
  }
  const storage = cfg.services['plane-minio'];
  assert.equal(storage.image, 'quay.io/minio/aistor/minio:RELEASE.2026-09-19T17-05-25Z@sha256:a94e1fe399bd050fe6d6148839597a4995350c0e62c9e83f0cec8b5630ed0a1e');
  assert.equal(storage.platform, 'linux/amd64');
  assert.deepEqual(storage.command, ['server', '/export', '--console-address', ':9090', '--license', '/minio.license']);
  const license = storage.volumes.find(v => v.target === '/minio.license');
  assert.equal(license.read_only, true);
  assert.notEqual(license.bind?.create_host_path, true);
  assert.equal(license.source, fixtures.MINIO_LICENSE_FILE);
  assert.ok(storage.tmpfs.some(t=>t.startsWith('/data:')));
  assert.ok(storage.cap_drop.includes('ALL'));
  assert.ok(storage.security_opt.includes('no-new-privileges:true'));
  assert.equal(cfg.services.api.depends_on['plane-minio'].condition, 'service_healthy');
  assert.equal(Object.entries(cfg.services).filter(([n])=>n!=='migrator').reduce((sum,[,s])=>sum+Number(s.mem_limit),0),4608*1024*1024);
  for (const name of ['api', 'worker', 'beat-worker', 'migrator']) {
    const e = cfg.services[name].environment;
    assert.equal(e.DATABASE_URL, fixtures.DATABASE_URL);
    assert.equal(e.AMQP_URL, fixtures.AMQP_URL);
    assert.equal(e.SECRET_KEY, fixtures.SECRET_KEY);
    assert.equal(e.AWS_SECRET_ACCESS_KEY, fixtures.AWS_SECRET_ACCESS_KEY);
    assert.equal(e.MINIO_ROOT_PASSWORD, fixtures.AWS_SECRET_ACCESS_KEY);
    assert.equal(e.WEB_URL, fixtures.WEB_URL);
    assert.equal(e.CORS_ALLOWED_ORIGINS, fixtures.WEB_URL);
  }
  for (const name of ['plane-db', 'plane-redis', 'plane-mq', 'plane-minio', 'api']) {
    assert.ok(cfg.services[name].healthcheck.test.length > 0);
  }
});
test('configuration fails closed without each required credential or ingress setting', () => {
  for (const name of Object.keys(fixtures).filter(n => !n.startsWith('CERT_'))) {
    const vars = { ...fixtures };
    delete vars[name];
    const result = render(vars);
    assert.equal(result.error, undefined, "Compose must actually execute");
    assert.notEqual(result.status, 0, `${name} must be required`);
  }
});
test('licensed storage runtime test is isolated with no published ports', () => {
 const result=spawnSync(bin,[...prefix,'--project-directory',`${dir}storage`,'--env-file','/dev/null',
  '-f',`${dir}storage/test.compose.yaml`,'--profile','test','config','--format','json'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const cfg=JSON.parse(result.stdout);
 assert.equal(cfg.networks.isolated.internal,true);
 for(const s of Object.values(cfg.services)){assert.equal(s.ports,undefined);assert.match(s.image,/@sha256:[a-f0-9]{64}$/);}
 assert.equal(cfg.services.storage.image,JSON.parse(readFileSync(`${dir}storage/provenance.json`)).image);
 assert.ok(!cfg.volumes.data.name.startsWith('plane_'));
});
