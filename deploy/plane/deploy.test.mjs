import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const script=new URL('deploy.sh',import.meta.url).pathname;
test('deployment syntax, reviewed-commit gate and safe staged ordering',()=>{
 assert.equal(spawnSync('sh',['-n',script]).status,0);
 for(const args of [[],['not-a-commit'],['a'.repeat(40)]]) assert.equal(spawnSync('sh',[script,...args]).status,2);
 const t=readFileSync(script,'utf8');
 assert.match(t,/flock -n 9/);assert.match(t,/config --quiet/);
 assert.match(t,/--force-recreate migrator/);assert.match(t,/\[ "\$result" = 0 \]/);
 assert.ok(t.indexOf('plane-db plane-redis plane-mq plane-minio')<t.indexOf('--force-recreate migrator'));
 assert.ok(t.indexOf('[ "$result" = 0 ]')<t.indexOf('--wait-timeout 300 api'));
 assert.doesNotMatch(t,/down|prune|docker logs|compose config.*json|tailscale.*(?:reset|funnel)/i);
});
