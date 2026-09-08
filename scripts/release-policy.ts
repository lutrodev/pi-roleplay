import { extname } from 'node:path'

const rootFiles = new Set(['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', '.gitignore', '.dockerignore', '.gitattributes', 'dev.sh', 'deploy.sh'])
const documents = new Set(['docs/architecture.md', 'docs/deployment.md', 'docs/development.md', 'docs/open-source.md', 'docs/ui-states.md', 'docs/writer-history.md', 'docs/model-reasoning.md', 'docs/source-provenance.json', 'docs/background-prompts.json', 'docs/dependency-licenses.json'])
const localRoots = new Set(['node_modules', '.git', '.dev', '.deploy', '.cache', '.playwright-cli', 'output', 'state', 'data', 'secrets', 'config', 'backups', 'coverage', 'test-results', 'playwright-report'])
const generatedDirectories = new Set(['node_modules', 'dist', 'output', '__pycache__'])
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.css', '.html', '.md', '.py', '.sh', '.yaml', '.yml'])

// Only these reviewed product assets are approved media. New/replaced assets need
// provenance review and a new digest; arbitrary uploads/screenshots never pass.
export const approvedMedia: Record<string, string> = {
  // User-requested provider logos from OpenCode (MIT); attribution in THIRD_PARTY_NOTICES.md.
  'apps/web/src/assets/provider-logos.svg': 'eeb1c093d9b046b560b85be2a0d09f2f7a80d8dafeef185b7a2077447c683d45',
  'apps/server/src/backgrounds/lantern-tavern.thumb.webp': 'ac8a35eac45beabd38089365b9e8e15d26a934f774f50f1058ae5779a19b9473',
  'apps/server/src/backgrounds/lantern-tavern.webp': '72c5de14132c8fb437a82885095b03be66072493864edf0ec87f927bab69bafc',
  'apps/server/src/backgrounds/misty-highlands.thumb.webp': 'eb262192c7b6f021a84e24b06e2e9abcc42c0c9063870ac1aa650c2ecbd311c4',
  'apps/server/src/backgrounds/misty-highlands.webp': 'be28c0b66e9f129605dab2021d791a3147fd5d72caf61ad8663d7d34bd3d6250',
  'apps/server/src/backgrounds/rainy-harbor.thumb.webp': '3a6ecf5d2de9ad55c8718171bdc5a4d36144d56636d4a68f24a7388f00a6637b',
  'apps/server/src/backgrounds/rainy-harbor.webp': '5aef3eaef23075a98afc6da9a4a3f2a5492b9779ad28968b2ca41aba03015907',
}

export function publicationScope(path: string): 'public' | 'local' | 'unreviewed' {
  const parts = path.split('/')
  if (localRoots.has(parts[0]!) || parts.some(part => generatedDirectories.has(part)) || parts.some(part => part === '.DS_Store')) return 'local'
  if (path === '.env.example') return 'public'
  if (parts.some(part => /^\.env(?:\.|$)/.test(part)) || /(?:\.sqlite(?:-[a-z]+)?|\.db|\.log|\.tsbuildinfo|\.pyc)$/.test(path)) return 'local'
  if (['.deploy.lock', 'design.md', 'docs/migration.md', 'scripts/test-summary-v4f.ts'].includes(path) || path.startsWith('docs/evidence/')) return 'local'
  if (path === 'skills/custom/.gitkeep') return 'public'
  if (path.startsWith('skills/custom/')) return 'local'
  if (rootFiles.has(path) || documents.has(path) || approvedMedia[path]) return 'public'
  if (path === 'deploy/Caddyfile' || /^deploy\/Dockerfile[.\w-]*$/.test(path)) return 'public'
  if (['apps', 'packages', 'tests', 'scripts', 'deploy'].includes(parts[0]!) && sourceExtensions.has(extname(path))) return 'public'
  if (path === 'skills/README.md' || path.startsWith('skills/builtin/') && sourceExtensions.has(extname(path))) return 'public'
  return 'unreviewed'
}

export function skipDirectory(path: string) {
  const parts = path.split('/')
  return localRoots.has(parts[0]!) || parts.some(part => generatedDirectories.has(part)) || path === 'docs/evidence'
}
