#!/usr/bin/env python3
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import json
import os
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class ArchiveValidation(unittest.TestCase):
    def archive(self, entries):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / 'backup.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            database = tarfile.TarInfo('app/app.sqlite'); database.size = 1
            archive.addfile(database, io.BytesIO(b'd'))
            for name, kind, value in entries:
                info = tarfile.TarInfo(name); info.type = kind
                if kind == tarfile.REGTYPE:
                    info.size = len(value); archive.addfile(info, io.BytesIO(value))
                else:
                    info.linkname = value; archive.addfile(info)
        return path

    def test_work_files_and_non_followed_runtime_symlinks(self):
        path = self.archive([('workspaces/story/note.txt', tarfile.REGTYPE, b'note'), ('workspaces/story/input', tarfile.SYMTYPE, '/inputs/original')])
        deployment.validate_archive(path, 1000)

    def test_escape_paths_and_link_parents_rejected_before_extract(self):
        cases = [
            [('app/../../outside', tarfile.REGTYPE, b'bad')],
            [('/outside', tarfile.REGTYPE, b'bad')],
            [('app/link', tarfile.SYMTYPE, '/etc')],
            [('workspaces/link', tarfile.SYMTYPE, '/etc'), ('workspaces/link/passwd', tarfile.REGTYPE, b'bad')],
            [('workspaces/cross', tarfile.LNKTYPE, 'app/app.sqlite')],
            [('workspaces/link', tarfile.SYMTYPE, '/etc'), ('workspaces/cross', tarfile.LNKTYPE, 'workspaces/link/passwd')],
        ]
        for entries in cases:
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                deployment.validate_archive(self.archive(entries), 1000)

    def test_devices_duplicates_missing_hardlink_and_disk_full_rejected(self):
        for entries in [
            [('workspaces/device', tarfile.CHRTYPE, '')],
            [('app/app.sqlite', tarfile.REGTYPE, b'other')],
            [('workspaces/missing', tarfile.LNKTYPE, 'workspaces/no-file')],
        ]:
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                deployment.validate_archive(self.archive(entries), 1000)
        with self.assertRaisesRegex(RuntimeError, '空间不足'):
            deployment.validate_archive(self.archive([('workspaces/file', tarfile.REGTYPE, b'large')]), 2)


class DeploymentFlows(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.joinpath('.env').write_text('COMPOSE_PROJECT_NAME=synthetic-update\nCOMPOSE_PROFILES=\nRP_APP_PORT=19767\nRP_PUBLIC_ORIGIN=http://127.0.0.1:19767\nRP_APP_IMAGE=app:old\nRP_TOOLS_IMAGE=tools:old\nRP_STORAGE_DIR=./state\n')
        self.root_patch = patch.object(deployment, 'ROOT', self.root)
        self.root_patch.start(); self.addCleanup(self.root_patch.stop)
        self.instance = deployment.Deployment()
        self.images = {'app': 'sha256:synthetic-old-app', 'tools': 'sha256:synthetic-old-tools'}
        self.instance.running_images = MagicMock(return_value=self.images)
        self.instance.control = MagicMock(return_value={'quiesced': False})
        self.instance.dc = MagicMock()
        self.instance.build = MagicMock()
        self.instance.start = MagicMock()
        self.instance.record = MagicMock()

    def test_build_failure_leaves_old_services_and_configuration_untouched(self):
        self.instance.build.side_effect = RuntimeError('build failed')
        self.instance.backup = MagicMock()
        original = self.root.joinpath('.env').read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'build failed'):
            self.instance.update()
        self.instance.backup.assert_not_called(); self.instance.start.assert_not_called(); self.instance.dc.assert_not_called()
        self.assertEqual(original, self.root.joinpath('.env').read_bytes())

    def test_busy_application_refuses_cutover_without_stopping_services(self):
        self.instance.control.side_effect = lambda command: (_ for _ in ()).throw(RuntimeError('still busy')) if command == 'quiesce' else {'quiesced': False}
        with patch.object(deployment, 'source_revision', return_value=None), self.assertRaisesRegex(RuntimeError, 'still busy'):
            self.instance.update()
        self.instance.dc.assert_not_called(); self.instance.start.assert_not_called()

    def test_success_updates_image_tags_only_after_backup_and_health_then_resumes(self):
        steps = []
        archive = self.root / 'backups' / 'synthetic.tar.gz'
        self.instance.backup = MagicMock(side_effect=lambda **kwargs: steps.append(('backup', kwargs)) or archive)
        self.instance.start.side_effect = lambda **kwargs: steps.append(('start', kwargs))
        self.instance.control.side_effect = lambda command: steps.append((command, {})) or {'quiesced': command == 'status' and len(steps) > 1}
        with patch.object(deployment, 'source_revision', return_value=None):
            self.instance.update()
        self.assertLess([s[0] for s in steps].index('backup'), [s[0] for s in steps].index('start'))
        self.assertEqual(steps[-1][0], 'resume')
        self.instance.backup.assert_called_once_with(keep_stopped=True)
        self.assertIn('RP_APP_IMAGE=app:release-', self.root.joinpath('.env').read_text())
        report = json.loads(next((self.root / '.deploy/updates').glob('*.json')).read_text())
        self.assertEqual(report['status'], 'completed'); self.assertEqual(report['previousImages'], self.images)
        self.assertEqual(report['backup'], 'backups/synthetic.tar.gz')

    def test_health_failure_stops_new_services_and_does_not_resume_or_reopen_old_database(self):
        self.instance.backup = MagicMock(return_value=self.root / 'backups' / 'before.tar.gz')
        self.instance.start.side_effect = RuntimeError('health failed')
        with patch.object(deployment, 'source_revision', return_value=None), self.assertRaisesRegex(RuntimeError, 'health failed'):
            self.instance.update()
        self.instance.dc.assert_called_once_with('stop', '--timeout', '30', 'app', 'tools')
        self.assertNotIn('resume', [call.args[0] for call in self.instance.control.call_args_list])
        self.assertEqual(self.instance.start.call_count, 1)
        report = json.loads(next((self.root / '.deploy/updates').glob('*.json')).read_text())
        self.assertEqual(report['status'], 'failed'); self.assertEqual(report['previousImages'], self.images)

    def prepare_backup(self, fail=False):
        self.instance.running = MagicMock(return_value='')
        def helper(command, *args, **kwargs):
            if command == 'pack':
                if fail: raise RuntimeError('pack failed')
                (self.instance.backups / args[0]).write_bytes(b'synthetic-packed-data')
        self.instance.helper = MagicMock(side_effect=helper)

    def test_backup_restarts_exact_running_image_ids_and_preserves_configured_tag(self):
        self.prepare_backup()
        archive = self.instance.backup()
        self.assertTrue(archive.exists())
        self.instance.start.assert_called_once_with(images=self.images)
        self.instance.control.assert_any_call('resume')
        self.assertEqual(self.instance.image, 'app:old')

    def test_update_backup_stays_stopped_but_pack_failure_recovers_old_services(self):
        self.prepare_backup()
        self.instance.backup(keep_stopped=True)
        self.instance.start.assert_not_called()
        self.assertNotIn('resume', [call.args[0] for call in self.instance.control.call_args_list])
        self.prepare_backup(fail=True)
        with self.assertRaisesRegex(RuntimeError, 'pack failed'):
            self.instance.backup(keep_stopped=True)
        self.instance.start.assert_called_once_with(images=self.images)
        self.instance.control.assert_any_call('resume')

    def test_image_repository_keeps_registry_port_and_git_is_optional_for_source_archives(self):
        self.assertEqual(deployment.image_repository('registry.example.test:5000/rp/app:old'), 'registry.example.test:5000/rp/app')
        self.assertEqual(deployment.image_repository('app@sha256:abc'), 'app')
        with patch.object(deployment.subprocess, 'run', side_effect=FileNotFoundError):
            self.assertIsNone(deployment.source_revision())

    def test_logs_work_without_service_arguments_and_do_not_take_deployment_lock(self):
        with patch.object(deployment.sys, 'argv', ['deploy.py', 'logs', '-f']), patch.object(deployment, 'Deployment', return_value=self.instance):
            deployment.main()
        self.instance.dc.assert_called_once_with('logs', '--tail', '100', '--follow')
        self.assertFalse((self.root / '.deploy.lock').exists())

    def test_start_selects_enabled_services_and_retires_only_its_previous_caddy(self):
        deployment.Deployment.start(self.instance, images=self.images, recreate=True)
        self.instance.dc.assert_any_call('up', '-d', '--no-build', '--wait', '--wait-timeout', '90', '--force-recreate', 'app', 'tools', images=self.images)
        self.instance.dc.assert_any_call('rm', '--stop', '--force', 'caddy')
        self.instance.dc.reset_mock(); self.instance.mode = 'caddy'
        deployment.Deployment.start(self.instance)
        self.instance.dc.assert_called_once_with('up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app', 'tools', 'caddy', images=None)


class ProxyConfiguration(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root_patch = patch.object(deployment, 'ROOT', self.root)
        self.root_patch.start(); self.addCleanup(self.root_patch.stop)

    def test_default_is_one_loopback_port_and_does_not_inherit_caddy_profile(self):
        deployment.configure('https://rp.example.test', 'synthetic-proxy')
        values = deployment.read_env()
        self.assertEqual(values['COMPOSE_PROFILES'], '')
        self.assertEqual(values['RP_APP_BIND_IP'], '127.0.0.1'); self.assertEqual(values['RP_APP_PORT'], '18767')
        with patch.dict(os.environ, {'COMPOSE_PROFILES': 'caddy'}):
            instance = deployment.Deployment()
        self.assertEqual(instance.services(), ['app', 'tools']); self.assertEqual(instance.env['COMPOSE_PROFILES'], '')

    def test_caddy_is_explicit_and_network_only_attaches_when_selected(self):
        deployment.configure('https://rp.example.test', 'synthetic-proxy', 'caddy', port=28767, bind='10.0.0.5', network='proxy-network')
        instance = deployment.Deployment()
        self.assertEqual(instance.services(), ['app', 'tools', 'caddy'])
        self.assertEqual(instance.env['COMPOSE_PROFILES'], 'caddy')
        self.assertEqual(instance.values['RP_APP_BIND_IP'], '10.0.0.5')
        self.assertIn(str(self.root / 'deploy/compose.proxy-network.yaml'), instance.compose)

    def test_invalid_options_create_no_configuration_or_keys(self):
        cases = [('https://rp.example.test', {'port': 3080}), ('https://rp.example.test', {'port': 65536}), ('https://rp.example.test', {'bind': 'not-an-ip'}), ('https://rp.example.test', {'network': '../private'}), ('https://rp.example.test\nRP_APP_PORT=80', {}), ('http://public.example.test', {})]
        for origin, options in cases:
            with self.subTest(origin=origin, options=options), self.assertRaises((RuntimeError, ValueError)):
                deployment.configure(origin, 'synthetic-proxy', **options)
        self.assertFalse((self.root / '.env').exists()); self.assertFalse((self.root / 'secrets').exists())

    def test_internal_http_origin_and_custom_port_are_supported(self):
        deployment.configure('http://10.0.0.5:28767', 'synthetic-proxy', bind='10.0.0.5')
        self.assertEqual(deployment.read_env()['RP_APP_PORT'], '28767')

    def test_mode_switch_preserves_keys_data_images_and_does_not_touch_services_until_up(self):
        deployment.configure('https://rp.example.test', 'synthetic-proxy', 'caddy', network='existing-proxy')
        original = {path: path.read_bytes() for path in (self.root / 'secrets').iterdir()}
        data = self.root / 'state/story.txt'; data.write_text('keep')
        with patch.object(deployment.sys, 'argv', ['deploy.py', 'proxy', 'external', '--port', '28767', '--proxy-network', '']), patch.object(deployment, 'execute') as execute:
            deployment.main(); execute.assert_not_called()
        values = deployment.read_env()
        self.assertEqual(values['COMPOSE_PROFILES'], ''); self.assertEqual(values['RP_APP_PORT'], '28767')
        self.assertEqual(values['RP_PROXY_NETWORK'], ''); self.assertEqual(values['RP_APP_IMAGE'], 'pi-roleplay-app:0.1.0')
        self.assertEqual(data.read_text(), 'keep')
        for path, content in original.items(): self.assertEqual(path.read_bytes(), content)

    def test_old_deployment_requires_explicit_mode_selection_and_retains_caddy_ports(self):
        self.root.joinpath('.env').write_text('COMPOSE_PROJECT_NAME=synthetic-proxy\nRP_PUBLIC_ORIGIN=https://rp.example.test\nRP_BIND_IP=0.0.0.0\nRP_HTTP_PORT=80\nRP_HTTPS_PORT=443\n')
        with self.assertRaisesRegex(RuntimeError, '旧部署尚未选择'):
            deployment.Deployment()
        with patch.object(deployment.sys, 'argv', ['deploy.py', 'proxy', 'caddy']): deployment.main()
        instance = deployment.Deployment()
        self.assertEqual(instance.mode, 'caddy'); self.assertEqual(instance.values['RP_HTTPS_PORT'], '443')

    def test_caddy_and_application_port_conflict_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, '端口不能相同'):
            deployment.configure('http://127.0.0.1:18767', 'synthetic-proxy', 'caddy')


class InstallationConfiguration(unittest.TestCase):
    required = ['secrets/models.env', 'secrets/session_key', 'secrets/tool_token', 'config/models.json']

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root_patch = patch.object(deployment, 'ROOT', self.root)
        self.root_patch.start(); self.addCleanup(self.root_patch.stop)
        self.environment = '# Keep this deployment configuration.\nCOMPOSE_PROJECT_NAME=synthetic-install\nCOMPOSE_PROFILES=\nRP_PUBLIC_ORIGIN=https://rp.example.test\nRP_APP_PORT=19767\nRP_STORAGE_DIR=./custom-state\nRP_APP_IMAGE=app:custom\nRP_TOOLS_IMAGE=tools:custom\n'
        (self.root / '.env').write_text(self.environment)
        self.argv = ['deploy.py', 'install', 'https://rp.example.test', '--project', 'synthetic-install']

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def test_env_only_install_prepares_every_file_before_docker_and_keeps_configuration(self):
        def running(service):
            self.assertEqual(service, 'app')
            self.assertTrue(all((self.root / name).is_file() for name in self.required))
            return ''
        with patch.object(deployment.sys, 'argv', self.argv), patch.object(deployment.Deployment, 'running', side_effect=running), patch.object(deployment.Deployment, 'build') as build, patch.object(deployment.Deployment, 'password'), patch.object(deployment.Deployment, 'helper'), patch.object(deployment.Deployment, 'start') as start:
            deployment.main()
        build.assert_called_once_with(); start.assert_called_once_with()
        self.assertEqual((self.root / '.env').read_text(), self.environment)
        self.assertEqual((self.root / 'secrets/session_key').stat().st_size, 32)
        self.assertRegex((self.root / 'secrets/tool_token').read_text(), r'^[A-Za-z0-9_-]{64}$')
        self.assertEqual(json.loads((self.root / 'config/models.json').read_text()), {'models': [], 'main': None})
        for name, mode in [('secrets/session_key', 0o444), ('secrets/tool_token', 0o444), ('secrets/models.env', 0o600), ('config/models.json', 0o644), ('skills/custom', 0o755)]:
            self.assertEqual((self.root / name).stat().st_mode & 0o777, mode)
        self.assertTrue((self.root / 'custom-state').is_dir())
        self.assertFalse((self.root / 'state').exists())

    def test_partial_initialization_and_build_retry_preserve_existing_files(self):
        key = self.write('secrets/session_key', bytes(range(32)))
        model = self.write('config/models.json', b'{ "models": [], "main": null }\n')
        key.chmod(0o444)
        originals = {key: key.read_bytes(), model: model.read_bytes()}
        with patch.object(deployment.sys, 'argv', self.argv), patch.object(deployment.Deployment, 'running', return_value=''), patch.object(deployment.Deployment, 'build', side_effect=RuntimeError('synthetic build failure')), patch.object(deployment.Deployment, 'password') as password, patch.object(deployment.Deployment, 'start') as start:
            with self.assertRaisesRegex(RuntimeError, 'synthetic build failure'):
                deployment.main()
            password.assert_not_called(); start.assert_not_called()
        created = {self.root / name: (self.root / name).read_bytes() for name in self.required}
        with patch.object(deployment.sys, 'argv', self.argv), patch.object(deployment.Deployment, 'running', return_value=''), patch.object(deployment.Deployment, 'build'), patch.object(deployment.Deployment, 'password'), patch.object(deployment.Deployment, 'helper'), patch.object(deployment.Deployment, 'start'):
            deployment.main()
        for path, content in {**created, **originals}.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual((self.root / '.env').read_text(), self.environment)

    def test_existing_database_with_missing_key_blocks_before_initialization_and_docker(self):
        database = self.write('custom-state/app/app.sqlite', b'synthetic database')
        with patch.object(deployment.sys, 'argv', self.argv), patch.object(deployment, 'execute') as execute:
            with self.assertRaisesRegex(RuntimeError, '恢复原加密密钥'):
                deployment.main()
            execute.assert_not_called()
        self.assertEqual(database.read_bytes(), b'synthetic database')
        self.assertFalse((self.root / 'secrets').exists())
        self.assertFalse((self.root / 'config').exists())

    def test_existing_database_is_not_repaired_or_reinstalled(self):
        self.write('custom-state/app/app.sqlite', b'synthetic database')
        key = self.write('secrets/session_key', bytes(range(32)))
        with patch.object(deployment.sys, 'argv', self.argv), patch.object(deployment, 'execute') as execute:
            with self.assertRaisesRegex(RuntimeError, '已有应用数据'):
                deployment.main()
            execute.assert_not_called()
        self.assertEqual(key.read_bytes(), bytes(range(32)))
        self.assertFalse((self.root / 'secrets/models.env').exists())

    def test_invalid_or_linked_existing_files_are_not_replaced(self):
        for name, content in [('secrets/session_key', b'invalid'), ('secrets/tool_token', b'invalid')]:
            with self.subTest(name=name):
                path = self.write(name, content)
                with patch.object(deployment.sys, 'argv', self.argv), patch.object(deployment, 'execute') as execute:
                    with self.assertRaisesRegex(RuntimeError, '未覆盖'):
                        deployment.main()
                    execute.assert_not_called()
                self.assertEqual(path.read_bytes(), content)
                self.assertFalse((self.root / 'config').exists())
                path.unlink()
        target = self.write('original-key', bytes(range(32)))
        (self.root / 'secrets/session_key').symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, '必须是普通文件'):
            deployment.deploy_config.prepare_installation(self.root, deployment.read_env())
        self.assertEqual(target.read_bytes(), bytes(range(32)))
        self.assertFalse((self.root / 'secrets/models.env').exists())

    def test_configure_does_not_create_new_identity_for_existing_data(self):
        (self.root / '.env').unlink()
        self.write('state/app/app.sqlite', b'synthetic database')
        with self.assertRaisesRegex(RuntimeError, '恢复原加密密钥'):
            deployment.configure('https://rp.example.test', 'synthetic-install')
        self.assertFalse((self.root / '.env').exists())
        self.assertFalse((self.root / 'secrets').exists())


if __name__ == '__main__':
    unittest.main()
