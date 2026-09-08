#!/usr/bin/env python3
"""Single-host deployment commands. Only Docker and Python's standard library are needed on the VPS."""
import argparse
import datetime as dt
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import deploy_config
from deploy_config import atomic_text, proxy_mode, proxy_values, save_values

ROOT = Path(__file__).resolve().parents[1]


def execute(args, *, data=None, capture=False, env=None):
    result = subprocess.run(args, input=data, text=True, capture_output=capture, env=env)
    if result.returncode:
        if capture and result.stderr:
            print(result.stderr.strip(), file=sys.stderr)
        if capture and result.stdout:
            print(result.stdout.strip(), file=sys.stderr)
        raise RuntimeError(f"命令执行失败（退出码 {result.returncode}）：{args[0]}")
    return result.stdout.strip() if capture else None


def read_env():
    return deploy_config.read_env(ROOT)

class Deployment:
    def __init__(self):
        self.values = read_env()
        self.mode = proxy_mode(self.values)
        proxy_values(self.values['RP_PUBLIC_ORIGIN'], self.mode, previous=self.values)
        self.env = dict(os.environ, **self.values)
        self.compose = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(ROOT / '.env'), '-f', str(ROOT / 'deploy/compose.yaml')]
        if self.values.get('RP_PROXY_NETWORK'):
            self.compose += ['-f', str(ROOT / 'deploy/compose.proxy-network.yaml')]
        self.storage = (ROOT / self.values.get('RP_STORAGE_DIR', './state')).resolve()
        self.backups = ROOT / 'backups'
        self.image = self.values.get('RP_APP_IMAGE', 'pi-roleplay-app:0.1.0')

    def dc(self, *args, images=None, **kwargs):
        overrides = {'RP_APP_IMAGE': images['app'], 'RP_TOOLS_IMAGE': images['tools']} if images else {}
        return execute(self.compose + list(args), env=dict(self.env, **overrides), **kwargs)

    def helper(self, command, *args, mounts=(), data=None, read_only=False):
        self.storage.mkdir(parents=True, exist_ok=True, mode=0o700)
        argv = ['docker', 'run', '--rm', '-i', '--network', 'none', '--user', '0:0', '--read-only', '--cap-drop', 'ALL',
                '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges',
                '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,noexec,size=32m',
                '--mount', f'type=bind,source={self.storage},target=/state' + (',readonly' if read_only else '')]
        for mount in mounts:
            argv += ['--mount', mount]
        execute(argv + [self.image, 'node', 'deploy-data.mjs', command, *args], data=data)

    def running(self, service):
        return self.dc('ps', '--status', 'running', '--quiet', service, capture=True)

    def control(self, command):
        return json.loads(self.dc('exec', '-T', 'app', 'node', 'dist/ops.js', command, capture=True))

    def start(self, images=None, recreate=False):
        args = ['up', '-d', '--no-build', '--wait', '--wait-timeout', '90']
        if recreate:
            args.append('--force-recreate')
        self.dc(*args, *self.services(), images=images)
        if self.mode == 'external':
            # A previously enabled Caddy must not survive a switch back to the user's proxy.
            # Only remove this Compose project's container, preserving its certificate volumes.
            self.dc('rm', '--stop', '--force', 'caddy')

    def services(self):
        return ['app', 'tools', *(['caddy'] if self.mode == 'caddy' else [])]

    def describe(self):
        print('公开访问地址：' + self.values['RP_PUBLIC_ORIGIN'])
        print(f"应用 HTTP 入口：{self.values.get('RP_APP_BIND_IP', '127.0.0.1')}:{self.values.get('RP_APP_PORT', '18767')}")
        if self.values.get('RP_PROXY_NETWORK'):
            print(f"Docker 反代网络：{self.values['RP_PROXY_NETWORK']}；上游：{self.values['COMPOSE_PROJECT_NAME']}-app:3091")
        print('代理模式：Caddy 接管 HTTP/HTTPS。' if self.mode == 'caddy' else '代理模式：用户自己的反代。请配置上游、域名与 HTTPS 后访问。')

    def running_images(self):
        containers = {name: self.running(name) for name in ['app', 'tools']}
        if not all(containers.values()):
            raise RuntimeError('app、tools 都需要在运行；首次部署请使用 install，已有部署先检查 status。')
        return {name: execute(['docker', 'inspect', '--format', '{{.Image}}', container], capture=True) for name, container in containers.items()}

    def build(self, images=None):
        for service in ['app', 'tools']:
            self.dc('build', service, images=images)

    def password(self, from_stdin=False):
        value = sys.stdin.read(4097).removesuffix('\n') if from_stdin else getpass.getpass('管理员密码：')
        if len(value) < 12 or len(value.encode('utf-16-le')) // 2 > 1024:
            raise RuntimeError('管理员密码需要 12 至 1024 个字符。')
        if not from_stdin and value != getpass.getpass('再次输入：'):
            raise RuntimeError('两次密码不同，未保存。')
        self.helper('init')
        argv = ['exec', '-T'] if self.running('app') else ['run', '--rm', '--no-deps', '-T']
        self.dc(*argv, 'app', 'node', 'dist/cli.js', 'set-password', '--password-stdin', data=value + '\n')

    def record(self, value):
        self.helper('record', data=json.dumps(value))

    def backup(self, keep_stopped=False):
        images = self.running_images()
        if self.control('status')['quiesced']:
            raise RuntimeError('应用已处于维护状态。请先检查上次操作结果并运行 resume。')
        configured_image = self.image
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
        name = f'rp-{stamp}.tar.gz'
        self.backups.mkdir(mode=0o700, exist_ok=True)
        partial = self.backups / (name + '.partial')
        archive = self.backups / name
        self.control('quiesce')
        self.image = images['app']
        stopped = False
        completed = False
        try:
            self.dc('stop', '--timeout', '30', 'app', 'tools')
            if self.running('app') or self.running('tools'):
                raise RuntimeError('容器未完全停止，未复制数据。')
            stopped = True
            self.helper('pack', partial.name, str(os.getuid()), str(os.getgid()),
                        mounts=[f'type=bind,source={self.backups},target=/backup'])
            digest = sha256(partial)
            manifest = {'format': 1, 'status': 'completed', 'file': name, 'sha256': digest, 'completedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'images': images}
            os.replace(partial, archive)
            metadata = archive.with_suffix(archive.suffix + '.json')
            metadata.write_text(json.dumps(manifest, indent=2) + '\n')
            os.chmod(metadata, 0o600)
            self.record(manifest)
            # A backup counts toward retention only when both archive and manifest exist.
            previous = sorted(self.backups.glob('rp-*.tar.gz.json'), reverse=True)
            for item in previous[7:]:
                item.with_suffix('').unlink(missing_ok=True)
                item.unlink()
            print('备份完成：' + str(archive))
            completed = True
            return archive
        except Exception:
            if stopped:
                self.record({'status': 'failed', 'completedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'message': '备份未完成，请查看部署命令的错误输出。'})
            raise
        finally:
            partial.unlink(missing_ok=True)
            try:
                # Restart exactly the backed-up images, even if a build has moved a mutable tag.
                # An update keeps the successful backup stopped and the durable write gate closed.
                if not (completed and keep_stopped):
                    self.start(images=images)
                    self.control('resume')
            finally:
                self.image = configured_image

    def update(self):
        previous_images = self.running_images()
        if self.control('status')['quiesced']:
            raise RuntimeError('应用处于维护状态；请先检查上次操作并明确运行 resume。')
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        images = {name: image_repository(self.values.get(key, f'pi-roleplay-{name}:0.1.0')) + ':release-' + stamp
                  for name, key in [('app', 'RP_APP_IMAGE'), ('tools', 'RP_TOOLS_IMAGE')]}
        print('先构建新镜像；现有服务继续运行。')
        self.build(images=images)
        if self.running_images() != previous_images:
            raise RuntimeError('构建期间运行镜像发生变化，更新已停止；请重新检查部署状态。')
        directory = ROOT / '.deploy' / 'updates'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        record_path = directory / (stamp + '.json')
        record = {'status': 'preparing', 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                  'previousImages': previous_images, 'nextImages': images,
                  'sourceRevision': source_revision(), 'previousSourceRevision': os.environ.get('RP_UPDATE_PREVIOUS_REVISION')}
        atomic_text(record_path, json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        atomic_text(directory / (stamp + '.env'), (ROOT / '.env').read_text())
        print('等待空闲检查、冷备份，然后切换新版本。')
        try:
            archive = self.backup(keep_stopped=True)
        except Exception:
            record['status'] = 'backup-failed'
            atomic_text(record_path, json.dumps(record, ensure_ascii=False, indent=2) + '\n')
            raise
        record.update(status='activating', backup=str(archive.relative_to(ROOT)))
        try:
            atomic_text(record_path, json.dumps(record, ensure_ascii=False, indent=2) + '\n')
            self.start(images=images, recreate=True)
            status = self.control('status')
            if not status['quiesced']:
                raise RuntimeError('更新期间维护标记意外消失；请检查应用状态。')
            save_images(images)
            self.control('resume')
        except Exception:
            # Startup may already have migrated SQLite. Never start an older app on that database.
            self.dc('stop', '--timeout', '30', 'app', 'tools')
            record['status'] = 'failed'
            atomic_text(record_path, json.dumps(record, ensure_ascii=False, indent=2) + '\n')
            print(f'更新未完成，app/tools 已停止。升级前备份：{archive}；旧镜像和配置：{record_path}。请查看 logs，或在空目录使用旧版本恢复备份。', file=sys.stderr)
            raise
        record.update(status='completed', completedAt=dt.datetime.now(dt.timezone.utc).isoformat())
        atomic_text(record_path, json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        print('更新完成，已启用服务的健康检查已通过：' + '、'.join(self.services()) + '。')

    def restore(self, archive):
        if self.dc('ps', '--status', 'running', '--quiet', capture=True):
            raise RuntimeError('恢复前必须停止这个部署的全部服务；请使用新项目名和空数据目录。')
        archive = archive.resolve()
        manifest = json.loads(archive.with_suffix(archive.suffix + '.json').read_text())
        if manifest.get('format') != 1 or manifest.get('sha256') != sha256(archive):
            raise RuntimeError('备份清单或 SHA-256 校验失败，未恢复。')
        self.storage.mkdir(parents=True, exist_ok=True, mode=0o700)
        validate_archive(archive, shutil.disk_usage(self.storage).free)
        self.helper('restore', mounts=[f'type=bind,source={archive},target=/archive/backup.tar.gz,readonly'])
        self.record({'status': 'restored', 'file': archive.name, 'sha256': manifest['sha256'], 'completedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
        print('已恢复数据库、附件和故事工作文件。配置与密钥需单独提供；运行 up 后验证登录与故事。')


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def image_repository(image):
    value = image.split('@', 1)[0]
    return value.rsplit(':', 1)[0] if ':' in value.rsplit('/', 1)[-1] else value


def save_images(images):
    save_values(ROOT, {'RP_APP_IMAGE': images['app'], 'RP_TOOLS_IMAGE': images['tools']})

def source_revision():
    try:
        result = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    except FileNotFoundError:
        return None
    if result.returncode or Path(result.stdout.strip()).resolve() != ROOT:
        return None
    return execute(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture=True)


def pull_source():
    revision = source_revision()
    if not revision:
        raise RuntimeError('--pull 需要独立 Git 克隆；源码压缩包请手动更新代码后运行 update。')
    if execute(['git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=no'], capture=True):
        raise RuntimeError('存在未提交的源码改动，未拉取或更新服务。请先提交或另行保存。')
    execute(['git', '-C', str(ROOT), 'pull', '--ff-only'])
    return revision


def validate_archive(path, free_bytes):
    """Check all paths before extraction; archive-created links must never become extraction parents."""
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        names, links, hardlinks, size = set(), set(), [], 0
        by_name = {str(PurePosixPath(member.name)): member for member in members}
        for member in members:
            value = PurePosixPath(member.name)
            if value.is_absolute() or '..' in value.parts or not value.parts or value.parts[0] not in ['app', 'workspaces']:
                raise RuntimeError('备份包含越界路径。')
            if str(value) in names or not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
                raise RuntimeError('备份包含重复路径或不支持的设备/管道。')
            names.add(str(value))
            size += member.size
            if member.issym() or member.islnk():
                links.add(str(value))
                if value.parts[0] != 'workspaces':
                    raise RuntimeError('应用数据目录不能包含链接。')
                destination = PurePosixPath(member.linkname)
                if member.islnk():
                    target = os.path.normpath(str(destination))
                    if destination.is_absolute() or not target.startswith('workspaces/'):
                        raise RuntimeError('工作文件硬链接越界。')
                    hardlinks.append(target)
                elif not destination.is_absolute():
                    target = os.path.normpath(str(value.parent / destination))
                    if target != 'workspaces' and not target.startswith('workspaces/'):
                        raise RuntimeError('工作文件符号链接越界。')
                # Absolute symlinks are preserved as links, never used as extraction parents.
        for member in members:
            if any(str(parent) in links for parent in PurePosixPath(member.name).parents):
                raise RuntimeError('备份试图通过链接写入文件。')
        for target in hardlinks:
            if target not in by_name or not by_name[target].isfile() or any(str(parent) in links for parent in PurePosixPath(target).parents):
                raise RuntimeError('硬链接目标必须是备份内的普通工作文件。')
        if size > free_bytes:
            raise RuntimeError('恢复目标的可用空间不足。')
        if 'app/app.sqlite' not in names:
            raise RuntimeError('备份缺少数据库。')


def configure(origin, project, mode='external', **options):
    deploy_config.configure(ROOT, origin, project, mode, **options)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    config = commands.add_parser('configure'); config.add_argument('origin'); config.add_argument('--project', default='pi-roleplay')
    install = commands.add_parser('install', help='首次配置、构建、设置密码并启动')
    install.add_argument('origin'); install.add_argument('--project', default='pi-roleplay'); install.add_argument('--password-stdin', action='store_true')
    for command in [config, install]:
        command.add_argument('--caddy', action='store_true', default=None, help='启用内置 Caddy 接管 80/443；默认使用用户自己的反代')
    proxy = commands.add_parser('proxy', help='保存代理接入方式；运行 up 应用，不修改数据或密钥')
    proxy.add_argument('mode', choices=['external', 'caddy']); proxy.add_argument('--origin', help='更新最终访问域名或内网地址')
    for command in [config, install, proxy]:
        command.add_argument('--port', type=int, help='应用的宿主机端口，默认 18767')
        command.add_argument('--bind', help='应用绑定的 IPv4 地址，默认 127.0.0.1；可指定 VPS 内网 IP')
        command.add_argument('--proxy-network', help='已有的 Docker 反代网络；传空字符串可移除接入')
    update = commands.add_parser('update', help='构建、冷备份、切换版本并检查健康状态')
    update.add_argument('--pull', action='store_true', help='先在干净的独立 Git 克隆中执行 git pull --ff-only')
    logs = commands.add_parser('logs', help='查看应用、工具和代理日志')
    logs.add_argument('services', nargs='*', choices=['app', 'tools', 'caddy'])
    logs.add_argument('--tail', type=int, default=100); logs.add_argument('-f', '--follow', action='store_true')
    for command in ['build', 'up', 'status', 'stop', 'backup', 'resume']:
        commands.add_parser(command)
    password = commands.add_parser('password'); password.add_argument('--password-stdin', action='store_true')
    restore = commands.add_parser('restore'); restore.add_argument('archive', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == 'logs':
        if args.tail < 1 or args.tail > 10000:
            raise RuntimeError('--tail 需要为 1–10000。')
        Deployment().dc('logs', '--tail', str(args.tail), *(['--follow'] if args.follow else []), *args.services)
        return
    with (ROOT / '.deploy.lock').open('a') as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('另一个部署、备份或恢复命令正在执行。')
        if args.command == 'configure':
            configure(args.origin, args.project, 'caddy' if args.caddy else 'external', port=args.port, bind=args.bind, network=args.proxy_network)
            return
        if args.command == 'proxy':
            values = read_env()
            selected = proxy_values(args.origin or values['RP_PUBLIC_ORIGIN'], args.mode, port=args.port, bind=args.bind, network=args.proxy_network, previous=values)
            save_values(ROOT, selected)
            print('代理配置已保存，数据与密钥保留。空闲时执行 ./deploy.sh up 应用配置。')
            Deployment().describe()
            return
        if args.command == 'install':
            if not (ROOT / '.env').exists():
                configure(args.origin, args.project, 'caddy' if args.caddy else 'external', port=args.port, bind=args.bind, network=args.proxy_network)
            else:
                values = read_env()
                if values.get('RP_PUBLIC_ORIGIN') != args.origin or values.get('COMPOSE_PROJECT_NAME') != args.project:
                    raise RuntimeError('现有部署的域名或项目名不同，未覆盖配置。')
                if args.caddy and proxy_mode(values) != 'caddy' or any(value is not None and str(value) != values.get(key) for key, value in [('RP_APP_PORT', args.port), ('RP_APP_BIND_IP', args.bind), ('RP_PROXY_NETWORK', args.proxy_network)]):
                    raise RuntimeError('安装参数与现有代理配置不同。请先用 proxy 命令明确选择接入方式。')
            deployment = Deployment()
            deploy_config.prepare_installation(ROOT, deployment.values)
            if deployment.running('app'):
                raise RuntimeError('已有应用数据。继续启动请使用 up；升级请使用 update；重置密码请使用 password。')
            deployment.build()
            deployment.password(args.password_stdin)
            deployment.helper('init'); deployment.start()
            print('首次部署完成：' + args.origin + '；登录后到“设置 → 模型”配置提供方。')
            deployment.describe()
            return
        if args.command == 'update' and args.pull:
            previous = pull_source()
            # Execute the newly pulled deployment code, not the old script with new source files.
            lock.close()
            os.execve(sys.executable, [sys.executable, str(ROOT / 'scripts/deploy.py'), 'update'], dict(os.environ, RP_UPDATE_PREVIOUS_REVISION=previous))
        deployment = Deployment()
        if args.command == 'build':
            deployment.build()
        elif args.command == 'update':
            deployment.update()
        elif args.command == 'up':
            deployment.helper('init'); deployment.start()
            deployment.describe()
        elif args.command == 'password':
            deployment.password(args.password_stdin)
        elif args.command == 'status':
            deployment.describe()
            deployment.dc('ps', 'app', 'tools', 'caddy')
            if deployment.running('app'):
                print(json.dumps(deployment.control('status'), ensure_ascii=False, indent=2))
        elif args.command == 'stop':
            deployment.dc('stop', '--timeout', '30', 'app', 'tools', 'caddy')
        elif args.command == 'backup':
            deployment.backup()
        elif args.command == 'restore':
            deployment.restore(args.archive)
        elif args.command == 'resume':
            print(json.dumps(deployment.control('resume'), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
