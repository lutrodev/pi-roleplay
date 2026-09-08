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


def configure(root, origin, project, mode='external', **options):
    values = proxy_values(origin, mode, **options)
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,49}', project):
        raise RuntimeError('项目名只能含小写字母、数字、下划线或连字符。')
    if (root / '.env').exists() or (root / 'secrets').exists():
        raise RuntimeError('部署配置已存在，未覆盖密钥或配置。')
    for name in ['secrets', 'config', 'state', 'backups']:
        (root / name).mkdir(mode=0o700, exist_ok=True)
    (root / 'skills/custom').mkdir(parents=True, mode=0o755, exist_ok=True)
    os.chmod(root / 'skills/custom', 0o755)
    values = {'COMPOSE_PROJECT_NAME': project, **values, 'RP_STORAGE_DIR': './state', 'RP_APP_IMAGE': 'pi-roleplay-app:0.1.0', 'RP_TOOLS_IMAGE': 'pi-roleplay-tools:0.1.0'}
    atomic_text(root / '.env', ''.join(key + '=' + value + '\n' for key, value in values.items()))
    (root / 'secrets/session_key').write_bytes(secrets.token_bytes(32))
    (root / 'secrets/tool_token').write_text(secrets.token_urlsafe(48))
    # Bind-file secrets retain host permissions; only these individual files go into containers.
    for name in ['session_key', 'tool_token']:
        os.chmod(root / 'secrets' / name, 0o444)
    (root / 'secrets/models.env').write_text('# Only app receives these environment variables.\nRP_MODEL_API_KEY=\n')
    os.chmod(root / 'secrets/models.env', 0o600)
    (root / 'config/models.json').write_text('{"models":[],"main":null}\n')
    os.chmod(root / 'config/models.json', 0o644)
    print('部署配置已建立，尚未启动服务。运行 build、password、up；登录后在网页配置模型。')
