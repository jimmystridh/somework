// SPDX-License-Identifier: MIT
// Run on Services ONLY through owner-approved host_exec. Never prints values.
import {randomBytes} from 'node:crypto';
import {openSync, writeFileSync, closeSync, lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function generate(directory, origin, storage = 'aistor') {
 if (!['aistor', 'garage'].includes(storage)) throw new Error('unreviewed storage implementation');
 const url = new URL(origin);
 if (url.origin !== origin || url.protocol !== 'https:' || url.hostname !== 'admin-cloud-agents.tail371505.ts.net' || url.port !== '8443')
  throw new Error('requires the reviewed existing-Agents HTTPS origin on port 8443');
 const stat = lstatSync(directory);
 if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
  throw new Error('requires an existing private mode-0700 directory');
 const secret = () => randomBytes(32).toString('hex');
 const pg = secret(), mq = secret();
 const values = {
  APP_RELEASE:'v1.4.2', APP_DOMAIN:url.hostname, WEB_URL:origin,
  MINIO_LICENSE_FILE:resolve(directory, 'minio.license'),
  POSTGRES_PASSWORD:pg, DATABASE_URL:`postgresql://plane:${pg}@plane-db/plane`,
  RABBITMQ_PASSWORD:mq, AMQP_URL:`amqp://plane:${mq}@plane-mq:5672/plane`,
  SECRET_KEY:secret(), LIVE_SERVER_SECRET_KEY:secret(),
  AWS_ACCESS_KEY_ID:storage === 'garage' ? `GK${randomBytes(12).toString('hex')}` : secret(), AWS_SECRET_ACCESS_KEY:secret(),
  ...(storage === 'garage' ? {AWS_REGION:'garage'} : {}),
  AWS_S3_BUCKET_NAME:'uploads', AWS_S3_ENDPOINT_URL:'http://plane-minio:9000',
  USE_MINIO:'1', MINIO_ENDPOINT_SSL:'0', SITE_ADDRESS:':80',
  CERT_EMAIL:'',CERT_ACME_CA:'',CERT_ACME_DNS:''
 };
 // Exclusive creation: refuse existing files/symlinks; never rotate or overwrite.
 const fd = openSync(resolve(directory, 'plane.env'), 'wx', 0o600);
 try {
  if (storage === 'garage') {
   const rpc = openSync(resolve(directory, 'garage_rpc'), 'wx', 0o600);
   try { writeFileSync(rpc, secret()); } finally { closeSync(rpc); }
  }
  writeFileSync(fd, Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''));
 }
 finally { closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 if (![4,5].includes(process.argv.length)) throw new Error('usage: generate-secrets.mjs PRIVATE_DIRECTORY VERIFIED_ORIGIN [aistor|garage]');
 generate(process.argv[2], process.argv[3], process.argv[4]);
}
