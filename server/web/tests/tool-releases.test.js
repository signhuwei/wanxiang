import { expect, test } from 'bun:test'
import { buildToolBundle } from '../policy-tools.js'

function folderFile(relativePath, content) {
  const file = new File([content], relativePath.split('/').at(-1))
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

test('packs a single Skill document as UTF-8 bytes', async () => {
  const markdown = '# 笔记\n'
  const bundle = await buildToolBundle({ kind: 'skill' }, [new File([markdown], 'SKILL.md')])
  expect(bundle.type).toMatch(/^application\/json(?:;|$)/)
  expect(JSON.parse(await bundle.text())).toEqual({ files: [{ path: 'SKILL.md', data: Buffer.from(markdown).toString('base64') }] })
})

test('removes the selected outer folder and keeps executable bytes and nested support files', async () => {
  const executable = Uint8Array.from({ length: 0x10001 }, (_, index) => index % 256)
  const bundle = await buildToolBundle({ kind: 'mcp', entrypoint: 'bin/tool.exe' }, [
    folderFile('selected/bin/tool.exe', executable), folderFile('selected/lib/settings.json', '{}'),
  ], true)
  const { files } = JSON.parse(await bundle.text())
  expect(files.map(file => file.path)).toEqual(['bin/tool.exe', 'lib/settings.json'])
  expect(Buffer.from(files[0].data, 'base64')).toEqual(Buffer.from(executable))
})

test('rejects a missing root manifest, case-insensitive duplicates, and nonportable names', async () => {
  await expect(buildToolBundle({ kind: 'skill' }, [folderFile('selected/notes/SKILL.md', '# Skill')], true)).rejects.toThrow('根层')
  await expect(buildToolBundle({ kind: 'skill' }, [new File(['# Skill'], 'SKILL.md'), new File(['# Skill'], 'skill.md')])).rejects.toThrow('重复')
  await expect(buildToolBundle({ kind: 'mcp', entrypoint: 'aux.exe' }, [new File(['fixture'], 'aux.exe')])).rejects.toThrow('路径无效')
})

test('uses portable path segments and excludes only the macOS metadata file in folder selections', async () => {
  const manifest = folderFile('selected/SKILL.md', '# Skill')
  const allowed = folderFile(`selected/_support/${'a'.repeat(80)}`, 'fixture')
  const metadata = folderFile('selected/.DS_Store', 'metadata')
  const bundle = await buildToolBundle({ kind: 'skill' }, [manifest, allowed, metadata], true)
  expect(JSON.parse(await bundle.text()).files.map(file => file.path)).toEqual(['SKILL.md', `_support/${'a'.repeat(80)}`])
  for (const filename of ['-support', '.gitignore', 'file.', 'COM0', 'LPT0.txt', 'a'.repeat(81)]) {
    await expect(buildToolBundle({ kind: 'skill' }, [manifest, folderFile(`selected/${filename}`, 'fixture')], true)).rejects.toThrow('路径无效')
  }
  await expect(buildToolBundle({ kind: 'mcp', entrypoint: '.DS_Store' }, [metadata])).rejects.toThrow('路径无效')
})
