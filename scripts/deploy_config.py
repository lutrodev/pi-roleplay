"""Deployment configuration; shares the launcher's Python standard-library runtime."""
import ipaddress
import json
import os
import re
import secrets
from urllib.parse import urlsplit


def read_env(root):
    path = root / '.env'
    if not path.exists():
        raise RuntimeError('请先运行 configure 配置部署目录。')
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise RuntimeError('.env 需要每行一个 KEY=value，不支持 shell 表达式。')
        values[key] = json.loads(value) if value.startswith('"') else value
        if not isinstance(values[key], str) or '\n' in values[key] or '\r' in values[key]:
            raise RuntimeError('.env 的值必须为单行文本。')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,49}', values.get('COMPOSE_PROJECT_NAME', '')):
        raise RuntimeError('COMPOSE_PROJECT_NAME 不正确。')
    return values


def atomic_text(path, content):
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(6))
    try:
        with temporary.open('x') as file:
            os.chmod(temporary, 0o600)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_values(root, replacements):
    replacements = dict(replacements)
    result = []
    for line in (root / '.env').read_text().splitlines():
        key = line.partition('=')[0]
        result.append(key + '=' + replacements.pop(key) if key in replacements else line)
    result += [key + '=' + value for key, value in replacements.items()]
    atomic_text(root / '.env', '\n'.join(result) + '\n')


def parse_origin(origin):
    url = urlsplit(origin)
    if (re.search(r'[\s$`{}]', origin) or url.scheme not in ['https', 'http'] or not url.hostname
            or url.username or url.password or url.path or url.query or url.fragment):
        raise RuntimeError('请填写没有路径的完整 origin，例如 https://rp.example.com。')
    if not re.fullmatch(r'[A-Za-z0-9.:-]+', url.hostname):
        raise RuntimeError('域名请使用 ASCII / Punycode 格式。')
    if url.port == 3080 or url.port == 0:
        raise RuntimeError('不能使用 3080 或无效端口。')
    if url.scheme == 'https' and url.port:
        raise RuntimeError('HTTPS 公开地址使用标准 443 端口，无需在域名后填写端口。')
    if url.scheme == 'http':
        try:
            address = ipaddress.ip_address(url.hostname)
            local = address.is_loopback or any(address in network for network in [ipaddress.ip_network('10.0.0.0/8'), ipaddress.ip_network('172.16.0.0/12'), ipaddress.ip_network('192.168.0.0/16'), ipaddress.ip_network('fc00::/7')])
        except ValueError:
            local = url.hostname == 'localhost'
        if not local:
            raise RuntimeError('HTTP 只供本机或内网访问；公网域名请使用 HTTPS。')
        if url.port == 80:
            raise RuntimeError('默认 HTTP 端口无需在 origin 中显式填写 :80。')
    return url


def proxy_mode(values):
    if 'COMPOSE_PROFILES' not in values:
        raise RuntimeError('旧部署尚未选择代理模式。先运行 ./deploy.sh proxy external，或 ./deploy.sh proxy caddy；配置和密钥会保留。')
    if values['COMPOSE_PROFILES'] not in ['', 'caddy']:
        raise RuntimeError('COMPOSE_PROFILES 只能留空（用户反代）或填写 caddy。')
    return 'caddy' if values['COMPOSE_PROFILES'] else 'external'


def proxy_values(origin, mode, *, port=None, bind=None, network=None, previous=None):
    if mode not in ['external', 'caddy']:
        raise RuntimeError('代理模式需要 external 或 caddy。')
    url = parse_origin(origin)
    previous = previous or {}
    app_port = str(port if port is not None else previous.get('RP_APP_PORT', url.port if mode == 'external' and url.scheme == 'http' and url.port else 18767))
    if not app_port.isascii() or not app_port.isdigit() or not 1024 <= int(app_port) <= 65535 or int(app_port) == 3080:
        raise RuntimeError('应用端口需要为 1024–65535，且不能使用 3080。')
    app_bind = bind if bind is not None else previous.get('RP_APP_BIND_IP', '127.0.0.1')
    try:
        app_bind = str(ipaddress.IPv4Address(app_bind))
    except ValueError:
        raise RuntimeError('绑定地址需要 IPv4 地址，例如 127.0.0.1 或 VPS 的内网 IP。')
    proxy_network = network if network is not None else previous.get('RP_PROXY_NETWORK', '')
    if proxy_network and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', proxy_network):
        raise RuntimeError('Docker 反代网络名称格式不正确。')
    local = url.scheme == 'http'
    http_port = previous.get('RP_HTTP_PORT', str(url.port or 80) if local else '80')
    https_port = previous.get('RP_HTTPS_PORT', '443')
    for value in [http_port, https_port]:
        if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= 65535 or int(value) == 3080:
            raise RuntimeError('Caddy 端口配置不正确。')
    if mode == 'caddy' and (int(app_port) in [int(http_port), int(https_port)] or http_port == https_port):
        raise RuntimeError('应用端口与 Caddy 端口不能相同，请用 --port 指定另一个应用端口。')
    return {'COMPOSE_PROFILES': 'caddy' if mode == 'caddy' else '', 'RP_PUBLIC_ORIGIN': origin,
            'RP_APP_BIND_IP': app_bind, 'RP_APP_PORT': app_port, 'RP_PROXY_NETWORK': proxy_network,
            'RP_SITE_ADDRESS': 'http://:80' if local else origin, 'RP_BIND_IP': previous.get('RP_BIND_IP', '127.0.0.1' if local else '0.0.0.0'),
            'RP_HTTP_PORT': http_port, 'RP_HTTPS_PORT': https_port}


def require_new_storage(root, values):
    storage = (root / values.get('RP_STORAGE_DIR', './state')).resolve()
    if os.path.lexists(storage / 'app/app.sqlite'):
        if not (root / 'secrets/session_key').is_file():
            raise RuntimeError('已有应用数据库但缺少原 secrets/session_key。请从原部署或备份恢复原加密密钥，不能重新生成。')
        raise RuntimeError('已有应用数据。继续启动请使用 up；升级请使用 update；重置密码请使用 password。')
    return storage


def create_file(path, content, mode):
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(6))
    try:
        with temporary.open('xb') as file:
            os.chmod(temporary, 0o600)
            file.write(content)
            file.flush()
            os.fchmod(file.fileno(), mode)
            os.fsync(file.fileno())
        # Publish a complete file without replacing a credential created meanwhile.
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare_installation(root, values):
    storage = require_new_storage(root, values)
    files = {
        'secrets/session_key': (lambda: secrets.token_bytes(32), 0o444),
        'secrets/tool_token': (lambda: secrets.token_urlsafe(48).encode(), 0o444),
        'secrets/models.env': (lambda: b'# Only app receives these environment variables.\nRP_MODEL_API_KEY=\n', 0o600),
        'config/models.json': (lambda: b'{"models":[],"main":null}\n', 0o644),
    }
    for name in ['secrets', 'config', 'skills', 'skills/custom']:
        path = root / name
        if path.is_symlink() or path.exists() and not path.is_dir():
            raise RuntimeError(f'{name} 必须是普通目录，未修改初始化文件。')
    for name in files:
        path = root / name
        if path.is_symlink() or path.exists() and not path.is_file():
            raise RuntimeError(f'{name} 必须是普通文件，未修改初始化文件。')
        if not path.exists():
            continue
        if name == 'secrets/session_key' and path.stat().st_size != 32:
            raise RuntimeError('现有 secrets/session_key 必须为 32 字节，未覆盖密钥。')
        if name == 'secrets/tool_token' and (path.stat().st_size > 512 or not re.fullmatch(rb'[A-Za-z0-9_-]{32,256}', path.read_bytes().strip())):
            raise RuntimeError('现有 secrets/tool_token 格式不正确，未覆盖令牌。')
    # Validate all existing paths before writing any missing initialization file.
    for directory in [root / 'secrets', root / 'config', storage, root / 'backups']:
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    custom = root / 'skills/custom'
    custom.mkdir(parents=True, mode=0o755, exist_ok=True)
    os.chmod(custom, 0o755)
    for name, (content, mode) in files.items():
        path = root / name
        if not path.exists():
            create_file(path, content(), mode)
            print('已生成缺失的初始化文件：' + name)


def configure(root, origin, project, mode='external', **options):
    values = proxy_values(origin, mode, **options)
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,49}', project):
        raise RuntimeError('项目名只能含小写字母、数字、下划线或连字符。')
    if (root / '.env').exists() or (root / 'secrets').exists():
        raise RuntimeError('部署配置已存在，未覆盖密钥或配置。')
    values = {'COMPOSE_PROJECT_NAME': project, **values, 'RP_STORAGE_DIR': './state', 'RP_APP_IMAGE': 'pi-roleplay-app:0.1.0', 'RP_TOOLS_IMAGE': 'pi-roleplay-tools:0.1.0'}
    require_new_storage(root, values)
    atomic_text(root / '.env', ''.join(key + '=' + value + '\n' for key, value in values.items()))
    prepare_installation(root, values)
    print('部署配置已建立，尚未启动服务。运行 build、password、up；登录后在网页配置模型。')
