import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillService } from '../apps/server/src/services/skill-service.ts'
import { SkillSession } from '../apps/server/src/runtime/skills.ts'

describe('skill discovery and invocation', () => {
  let directory: string, service: SkillService
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-roleplay-skills-')))
    service = new SkillService([{ path: directory, virtualPath: '/skills/custom' }])
  })
  afterEach(async () => rm(directory, { recursive: true, force: true }))
  async function skill(folder: string, text: string) { await mkdir(join(directory, folder), { recursive: true }); await writeFile(join(directory, folder, 'SKILL.md'), text) }
  const guide = '---\nname: blueprint\ndescription: Build a scene outline.\n---\nRead references/details.md before writing an outline.\n'

  it('ships all seven reviewed RP guides, including the routed SillyTavern import guide', async () => {
    const snapshot = await new SkillService([{ path: fileURLToPath(new URL('../skills/builtin', import.meta.url)), virtualPath: '/skills/builtin' }]).snapshot()
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.skills.map(skill => skill.name)).toEqual(['rp-guide-character-card', 'rp-guide-lorebook', 'rp-guide-persona', 'rp-guide-preset', 'rp-guide-preset-sillytavern', 'rp-guide-state', 'rp-guide-writing-style'])
    expect(snapshot.skills.find(skill => skill.name === 'rp-guide-preset-sillytavern')?.userInvocable).toBe(false)
  })

  it('loads an exact frozen definition with a tool-visible resource base', async () => {
    await skill('blueprint', guide)
    const snapshot = await service.snapshot(), session = new SkillSession(snapshot)
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.skills[0]).toMatchObject({ name: 'blueprint', resourceBase: { kind: 'directory', path: '/skills/custom/blueprint' }, modelInvocable: true, userInvocable: true })
    expect(() => session.require('blueprint')).toThrow('先加载')
    await writeFile(join(directory, 'blueprint', 'SKILL.md'), guide.replace('outline.', 'different result.'))
    const result = await session.tool().execute('call', { name: 'blueprint' }, new AbortController().signal)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('outline.') })
    expect(JSON.stringify(result)).not.toContain('different result.')
    expect(() => session.require('blueprint')).not.toThrow()
    expect(() => new SkillSession(snapshot).require('blueprint')).toThrow('先加载')
  })

  it('supports explicit user invocation while respecting model/user invocation flags', async () => {
    await skill('manual', '---\nname: manual-only\ndescription: User-triggered import.\ndisable-model-invocation: true\n---\nManual import instructions.')
    await skill('automatic', '---\nname: automatic-only\ndescription: Model-triggered helper.\nuser-invocable: false\n---\nAutomatic instructions.')
    const snapshot = await service.snapshot()
    const session = new SkillSession(snapshot, ['请用 /manual-only 帮忙。', '/automatic-only'])
    expect(() => session.require('manual-only')).not.toThrow()
    expect(() => session.require('automatic-only')).toThrow('先加载')
    expect(session.parentInstructions).toContain('Manual import instructions.')
    await expect(session.tool().execute('call', { name: 'manual-only' }, new AbortController().signal)).rejects.toThrow('SKILL_NOT_AVAILABLE')
    const pathsOnly = new SkillSession(snapshot, ['/manual-only/file.md https://example.test/manual-only'])
    expect(() => pathsOnly.require('manual-only')).toThrow('先加载')
  })

  it('reports duplicate, malformed and symlinked definitions without choosing one silently', async () => {
    await skill('first', guide); await skill('second', guide)
    await skill('bad', '---\nname: Uppercase\ndescription: Invalid name\n---\nBody')
    await symlink(join(directory, 'first'), join(directory, 'linked'))
    const snapshot = await service.snapshot()
    expect(snapshot.skills).toEqual([])
    expect(snapshot.diagnostics.map(item => item.message).join(' ')).toMatch(/重复/)
    expect(snapshot.diagnostics.map(item => item.message).join(' ')).toMatch(/小写/)
    expect(snapshot.diagnostics.map(item => item.message).join(' ')).toMatch(/符号链接/)
  })

  it('keeps disabled skills unavailable and rejects oversized or executable YAML definitions', async () => {
    await skill('blueprint', guide)
    await skill('large', guide + 'x'.repeat(65536))
    await skill('unsafe', '---\nname: unsafe\ndescription: !!js/function "function () { return process.env }"\n---\nUnsafe')
    const snapshot = await service.snapshot(['blueprint'])
    expect(snapshot.skills).toEqual([])
    expect(snapshot.diagnostics).toHaveLength(2)
  })
})
