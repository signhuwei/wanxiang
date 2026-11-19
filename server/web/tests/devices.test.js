import {test,expect} from 'bun:test'
import {downloadUrl} from '../devices.js'
test('diagnostic links accept web URLs, never executable schemes or credentials',()=>{
  const base='http://127.0.0.1/'
  expect(downloadUrl('/logs/1',base)).toBe(base+'logs/1')
  expect(downloadUrl('https://storage.example.test/archive',base)).toBe('https://storage.example.test/archive')
  for(const bad of [null,'', 'javascript:void(0)','data:text/html,example','https://user@host/a']) expect(downloadUrl(bad,base)).toBeNull()
})
