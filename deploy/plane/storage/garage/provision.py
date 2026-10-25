"""Candidate bootstrap; host_exec approval REQUIRED for production secret reads.

Secrets travel only on docker exec stdin, never argv, logs or API error output.
Run AFTER explicit layout initialization. No automatic disk sizing/data conversion.
"""
import hmac
import json
import re
import stat
import subprocess
import sys
from pathlib import Path


def validate_credentials(access, secret, bucket):
    if not re.fullmatch(r'GK[0-9a-f]{24}', access):
        raise ValueError('Garage access key must be GK plus 24 hex digits')
    if not re.fullmatch(r'[0-9a-f]{64}', secret):
        raise ValueError('requires a host-generated 256-bit secret')
    if bucket != 'uploads':
        raise ValueError('requires the reviewed uploads bucket')


def bootstrap(api, access, secret, bucket):
    validate_credentials(access, secret, bucket)
    buckets = api('ListBuckets', None)
    matches = [b for b in buckets if bucket in b['globalAliases']]
    if len(matches) > 1:
        raise ValueError('ambiguous bucket alias')
    info = (api('GetBucketInfo', {'id': matches[0]['id']}) if matches else
            api('CreateBucket', {'globalAlias': bucket}))
    if info['websiteAccess']:
        raise ValueError('refusing existing public website bucket')
    bucket_id = info['id']
    keys = api('ListKeys', None)
    if not any(k['id'] == access for k in keys):
        api('ImportKey', {'accessKeyId': access, 'secretAccessKey': secret, 'name': 'plane'})
    key = api('GetKeyInfo', {'id': access, 'showSecretKey': True})
    if not hmac.compare_digest(key.get('secretAccessKey') or '', secret):
        raise ValueError('existing Garage key has a different secret than plane.env')
    if key['permissions']['createBucket']:
        raise ValueError('refusing a key with bucket-creation privileges')
    if any(b['id'] != bucket_id or b['permissions']['owner'] for b in key['buckets']):
        raise ValueError('refusing a key with unrelated or administrative bucket grants')
    api('AllowBucketKey', {'bucketId': bucket_id, 'accessKeyId': access,
                          'permissions': {'read': True, 'write': True, 'owner': False}})
    key = api('GetKeyInfo', {'id': access, 'showSecretKey': False})
    if len(key['buckets']) != 1 or key['buckets'][0]['permissions'] != {
            'read': True, 'write': True, 'owner': False}:
        raise ValueError('unexpected effective key permissions')


def docker_api(container):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+', container):
        raise ValueError('invalid container name')
    def call(endpoint, payload):
        p = subprocess.run(['docker', 'exec', '-i', container, '/garage', 'json-api', endpoint, '-'],
                           input=json.dumps(payload), text=True, capture_output=True, timeout=60)
        if p.returncode:
            # Garage errors may echo secret-bearing requests: never include stderr/stdout.
            raise RuntimeError('Garage operation failed: ' + endpoint)
        try:
            return json.loads(p.stdout)
        except ValueError:
            raise RuntimeError('invalid Garage response: ' + endpoint) from None
    return call


def load_env(path):
    p = Path(path)
    s = p.lstat()
    if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode) != 0o600:
        raise ValueError('requires a regular private mode-0600 environment file')
    values = dict(line.split('=', 1) for line in p.read_text().splitlines() if line)
    if values.get('AWS_REGION') != 'garage' or values.get('AWS_S3_ENDPOINT_URL') != 'http://plane-minio:9000':
        raise ValueError('requires explicit matching Garage region and private endpoint')
    validate_credentials(values['AWS_ACCESS_KEY_ID'], values['AWS_SECRET_ACCESS_KEY'],
                         values['AWS_S3_BUCKET_NAME'])
    return values


def main(argv):
    try:
        if len(argv) != 2:
            raise ValueError('usage: provision.py PRIVATE_PLANE_ENV CONTAINER_OR_--check')
        env = load_env(argv[0])
        if argv[1] != '--check':
            bootstrap(docker_api(argv[1]), env['AWS_ACCESS_KEY_ID'],
                      env['AWS_SECRET_ACCESS_KEY'], env['AWS_S3_BUCKET_NAME'])
            print('Private Garage bucket and read/write-only Plane key provisioned')
        return 0
    except Exception:
        # Even malformed secret-file content must not leak through a traceback.
        print('Garage provisioning failed; inspect prerequisites without printing secrets', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
