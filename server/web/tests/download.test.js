import { test, expect } from 'bun:test'
import { detectOs, pickDefault, sameOriginDownloadUrl } from '../download.js'

test('detects macOS and Windows from the user agent, else leaves it unknown', () => {
  expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('darwin')
  expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
  expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBeNull()
  expect(detectOs(undefined)).toBeNull()
})

test('default platform stays on the detected OS even when it has no releases, never silently switches', () => {
  const macOnly = [{ os: 'darwin', id: 'a' }]
  expect(pickDefault(macOnly, 'windows')).toBe('windows') // 识别到 Windows，即使只有 Mac 包也不能换
  expect(pickDefault(macOnly, 'darwin')).toBe('darwin')
  expect(pickDefault(macOnly, null)).toBe('darwin') // 未识别：退到第一条有数据的平台
  expect(pickDefault([], null)).toBe('darwin') // 没有任何发布：固定平台列表里的第一个
})

test('download URL must be same-origin and point at this exact release id download route', () => {
  const base = 'http://192.168.3.211:18700/download'
  const good = 'http://192.168.3.211:18700/v1/desktop-releases/rel_1/download'
  expect(sameOriginDownloadUrl(good, 'rel_1', base)).toBe(good)
  for (const bad of [
    null, '', 'javascript:void(0)',
    'http://192.168.3.211:18700/v1/desktop-releases/rel_2/download', // 另一条记录的下载地址
    'https://evil.example.test/v1/desktop-releases/rel_1/download',  // 跨域
    'http://user:pass@192.168.3.211:18700/v1/desktop-releases/rel_1/download', // 带凭据
    'http://192.168.3.211:18700/v1/desktop-releases/rel_1/download?x=1' // 多余查询参数不是精确路由
  ]) expect(sameOriginDownloadUrl(bad, 'rel_1', base)).toBeNull()
})
