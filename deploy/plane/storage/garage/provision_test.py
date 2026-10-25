"""Unit tests run with stdlib Python; fixtures contain no production secrets."""
import unittest
import tempfile
import os
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from provision import bootstrap, docker_api, load_env, main
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO

KEY = 'GK0123456789abcdef01234567'
SECRET = '0123456789abcdef' * 4

class Fake:
    def __init__(self):
        self.calls = []
        self.exists = False
        self.key_exists = False
        self.stored_secret = SECRET
        self.public = False
        self.create_bucket = False
        self.extra_bucket = False
        self.owner = False
        self.granted = False
    def __call__(self, endpoint, payload):
        self.calls.append((endpoint, payload))
        if endpoint == 'ListBuckets':
            return [{'id': 'bucket', 'globalAliases': ['uploads']}] if self.exists else []
        if endpoint in ('CreateBucket', 'GetBucketInfo'):
            self.exists = True
            return {'id': 'bucket', 'websiteAccess': self.public}
        if endpoint == 'ListKeys':
            return [{'id': KEY}] if self.key_exists else []
        if endpoint == 'ImportKey':
            self.key_exists = True
            return {}
        if endpoint == 'AllowBucketKey':
            self.granted = True
            return {}
        if endpoint == 'GetKeyInfo':
            result = {'secretAccessKey': self.stored_secret} if payload['showSecretKey'] else {}
            buckets = [{'id': 'other' if self.extra_bucket else 'bucket',
                        'permissions': {'owner': self.owner, 'read': True, 'write': True}}] if (self.granted or self.extra_bucket or self.owner) else []
            return {**result, 'permissions': {'createBucket': self.create_bucket}, 'buckets': buckets}
        raise AssertionError(endpoint)

class ProvisionTest(unittest.TestCase):
    def test_new_and_restart(self):
        api = Fake()
        bootstrap(api, KEY, SECRET, 'uploads')
        imports = sum(e == 'ImportKey' for e, _ in api.calls)
        bootstrap(api, KEY, SECRET, 'uploads')
        self.assertEqual(sum(e == 'ImportKey' for e, _ in api.calls), imports)
        self.assertEqual(imports, 1)
        self.assertIn(('AllowBucketKey', {'bucketId': 'bucket', 'accessKeyId': KEY,
                          'permissions': {'read': True, 'write': True, 'owner': False}}), api.calls)
    def test_existing_key_with_other_secret_rejected(self):
        api = Fake()
        api.key_exists = True
        api.stored_secret = 'f' * 64
        with self.assertRaises(ValueError):
            bootstrap(api, KEY, SECRET, 'uploads')
        self.assertFalse(any(e in ('ImportKey', 'AllowBucketKey') for e, _ in api.calls))
    def test_wider_permissions_rejected(self):
        for attribute in ('public', 'create_bucket', 'extra_bucket', 'owner'):
            api = Fake()
            setattr(api, attribute, True)
            with self.assertRaises(ValueError):
                bootstrap(api, KEY, SECRET, 'uploads')
            self.assertFalse(any(e == 'AllowBucketKey' for e, _ in api.calls))
    def test_invalid_input_has_no_effect(self):
        for args in [('wrong-id', SECRET, 'uploads'), (KEY, 'short', 'uploads'), (KEY, SECRET, 'other')]:
            api = Fake()
            with self.assertRaises(ValueError):
                bootstrap(api, *args)
            self.assertFalse(api.calls)

class PrivacyTest(unittest.TestCase):
    def test_secret_is_stdin_not_argv(self):
        with patch('provision.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{}')) as run:
            docker_api('fixture')('ImportKey', {'secretAccessKey': SECRET})
            args, kwargs = run.call_args
            self.assertNotIn(SECRET, ' '.join(args[0]))
            self.assertEqual(json.loads(kwargs['input'])['secretAccessKey'], SECRET)
            self.assertTrue(kwargs['capture_output'])
    def test_api_errors_do_not_echo_values(self):
        with patch('provision.subprocess.run', return_value=SimpleNamespace(returncode=1, stdout=SECRET, stderr=SECRET)):
            with self.assertRaises(RuntimeError) as context:
                docker_api('fixture')('ImportKey', {'secretAccessKey': SECRET})
            self.assertNotIn(SECRET, str(context.exception))
    def test_private_file_region_and_symlink_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'plane.env'
            p.write_text('AWS_REGION=garage\nAWS_S3_ENDPOINT_URL=http://plane-minio:9000\n'
                         f'AWS_ACCESS_KEY_ID={KEY}\nAWS_SECRET_ACCESS_KEY={SECRET}\nAWS_S3_BUCKET_NAME=uploads\n')
            p.chmod(0o600)
            self.assertEqual(load_env(p)['AWS_REGION'], 'garage')
            p.chmod(0o644)
            with self.assertRaises(ValueError):
                load_env(p)
            p.chmod(0o600)
            link = Path(directory) / 'link'
            link.symlink_to(p)
            with self.assertRaises(ValueError):
                load_env(link)
            p.write_text('AWS_REGION=wrong\nAWS_S3_ENDPOINT_URL=http://plane-minio:9000\n')
            with self.assertRaises(ValueError):
                load_env(p)

class PreflightTest(unittest.TestCase):
    def test_check_has_no_docker_effect_or_output(self):
        env = {'AWS_ACCESS_KEY_ID': KEY, 'AWS_SECRET_ACCESS_KEY': SECRET,
               'AWS_S3_BUCKET_NAME': 'uploads'}
        out, err = StringIO(), StringIO()
        with patch('provision.load_env', return_value=env), patch('provision.docker_api') as api, redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(main(['fixture', '--check']), 0)
            api.assert_not_called()
        self.assertEqual(out.getvalue() + err.getvalue(), '')
    def test_malformed_file_does_not_echo_values(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'plane.env'
            p.write_text('AWS_REGION=garage\nAWS_S3_ENDPOINT_URL=http://plane-minio:9000\n'
                         f'AWS_ACCESS_KEY_ID={SECRET}\nAWS_SECRET_ACCESS_KEY={SECRET}\nAWS_S3_BUCKET_NAME=uploads\n')
            p.chmod(0o600)
            out, err = StringIO(), StringIO()
            with redirect_stdout(out), redirect_stderr(err), patch('provision.docker_api') as api:
                self.assertEqual(main([str(p), '--check']), 1)
                api.assert_not_called()
            self.assertNotIn(SECRET, out.getvalue() + err.getvalue())

if __name__ == '__main__':
    unittest.main()
