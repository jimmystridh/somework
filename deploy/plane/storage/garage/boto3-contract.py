"""Public isolated fixtures only; run using the pinned Plane backend's boto3."""
import io
import sys
import urllib.error
import urllib.request
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

ENDPOINT = 'http://plane-garage-contract:9000'
KEY = 'GK0123456789abcdef01234567'
SECRET = '0123456789abcdef' * 4
BUCKET = 'uploads'
OBJECT = 'contract/boto3.txt'
BODY = b'Plane Garage actual boto3 contract\n'

def client(secret=SECRET, region='garage', key=KEY):
    return boto3.client('s3', endpoint_url=ENDPOINT, region_name=region,
                       aws_access_key_id=key, aws_secret_access_key=secret,
                       config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}))

def denied(url, status=403):
    try:
        urllib.request.urlopen(url, timeout=10)
    except urllib.error.HTTPError as e:
        assert e.code == status, e.code
    else:
        raise AssertionError('unauthorized object was readable')

s3 = client()
if '--verify' not in sys.argv:
    post = s3.generate_presigned_post(BUCKET, OBJECT, ExpiresIn=120)
    boundary = 'plane-contract-boundary'
    parts = []
    for name, value in post['fields'].items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode() + BODY + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    req = urllib.request.Request(post['url'], data=b''.join(parts),
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    assert urllib.request.urlopen(req, timeout=10).status in (200, 201, 204)
    print('PASS boto3 presigned POST')
    s3.copy_object(Bucket=BUCKET, Key=OBJECT + '.copy', CopySource={'Bucket': BUCKET, 'Key': OBJECT})
    s3.upload_fileobj(io.BytesIO(BODY), BUCKET, OBJECT + '.upload')
for key in (OBJECT, OBJECT + '.copy', OBJECT + '.upload'):
    assert s3.head_object(Bucket=BUCKET, Key=key)['ContentLength'] == len(BODY)
    url = s3.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': key,
        'ResponseContentDisposition': 'attachment; filename="fixture.txt"'}, ExpiresIn=120)
    with urllib.request.urlopen(url, timeout=10) as response:
        assert response.read() == BODY
        assert response.headers['Content-Disposition'] == 'attachment; filename="fixture.txt"'
print('PASS GET disposition, copy/head, upload_fileobj and persisted contents')
denied(f'{ENDPOINT}/{BUCKET}/{OBJECT}')
for c in (client('bad-secret'), client(key='GKaaaaaaaaaaaaaaaaaaaaaaaa')):
    denied(c.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': OBJECT}, ExpiresIn=120))
denied(client(region='wrong-region').generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': OBJECT}), status=400)
print('PASS unsigned, wrong-secret, wrong-key and wrong-region rejection')
for api, args in [('put_bucket_acl', {'ACL': 'public-read'}),
                  ('put_bucket_policy', {'Policy': '{"Version":"2012-10-17","Statement":[]}'})]:
    try:
        getattr(s3, api)(Bucket=BUCKET, **args)
    except ClientError as e:
        assert e.response['Error']['Code'] in ('NotImplemented', 'AccessDenied'), e.response['Error']['Code']
    else:
        raise AssertionError('unexpected ACL/policy support')
print('PASS unsupported ACL/policy rejected; private per-key permissions required')
