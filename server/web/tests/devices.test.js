import {test,expect} from 'bun:test'
import {diagnosticDownloadPath,downloadUrl} from '../devices.js'
test('diagnostic links accept web URLs, never executable schemes or credentials',()=>{
  const base='http://127.0.0.1/'
  expect(downloadUrl('/logs/1',base)).toBe(base+'logs/1')
  expect(downloadUrl('https://storage.example.test/archive',base)).toBe('https://storage.example.test/archive')
  for(const bad of [null,'', 'javascript:void(0)','data:text/html,example','https://user@host/a']) expect(downloadUrl(bad,base)).toBeNull()
})

test('authenticated diagnostics only download the requested job on the same origin',()=>{
  const base='http://127.0.0.1/'
  const path='/v1/diag/dia_1/download'
  expect(diagnosticDownloadPath(path,'dia_1',base)).toBe('/diag/dia_1/download')
  for(const bad of [path+'?other=true','/v1/diag/dia_2/download','https://storage.example.test'+path,'/v1/me']) {
    expect(diagnosticDownloadPath(bad,'dia_1',base)).toBeNull()
  }
})
