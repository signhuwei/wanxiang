import { test, expect } from 'bun:test'
import { statusLabel, platformLabel, shortSha256, validateArtifactFile, MAX_ARTIFACT_BYTES } from '../releases.js'

test('status labels are Chinese for all contract states, fall back to raw value otherwise', () => {
  expect(statusLabel('draft')).toBe('草稿')
  expect(statusLabel('published')).toBe('已发布')
  expect(statusLabel('unlisted')).toBe('已下架')
  expect(statusLabel('weird')).toBe('weird')
})

test('platform label combines readable OS name with raw arch', () => {
  expect(platformLabel({ os: 'darwin', arch: 'arm64' })).toBe('macOS / arm64')
  expect(platformLabel({ os: 'windows', arch: 'x64' })).toBe('Windows / x64')
})

test('sha256 is shown truncated so the row stays scannable', () => {
  const full = 'a'.repeat(64)
  expect(shortSha256(full)).toBe('a'.repeat(12) + '…')
  expect(shortSha256(null)).toBe('—')
})

test('artifact validation rejects missing file, oversized file, and wrong extension per platform', () => {
  expect(validateArtifactFile('darwin', null)).toMatch(/选择/)
  expect(validateArtifactFile('darwin', { name: 'x.exe', size: 10 })).toMatch(/pkg/)
  expect(validateArtifactFile('windows', { name: 'x.pkg', size: 10 })).toMatch(/exe/)
  expect(validateArtifactFile('darwin', { name: 'x.pkg', size: MAX_ARTIFACT_BYTES + 1 })).toMatch(/256 MiB/)
  expect(validateArtifactFile('darwin', { name: 'x.pkg', size: 10 })).toBeNull()
  expect(validateArtifactFile('windows', { name: 'x.exe', size: 10 })).toBeNull()
})
