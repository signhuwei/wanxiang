import { expect, test } from 'bun:test';
import { hasDesktopRuntime, qualifiedDesktopRelease } from '../src/agent-catalog';
import builds from '../src/desktop-qualifications.json';

test('native runtime qualification follows the exact approved build', () => {
  const official = builds.find(row => row.agent === 'deepseek-desktop' && row.qualified)!;
  expect(qualifiedDesktopRelease(official)).toBeTrue();
  expect(hasDesktopRuntime(official.agent, official.os, official.arch)).toBeTrue();
  for (const replacement of [
    { agent: 'workbuddy' }, { version: 'other-build' }, { os: 'win32' }, { arch: 'x64' },
    { sha256: 'a'.repeat(64) }, { size: official.size - 1 },
  ]) {
    expect(qualifiedDesktopRelease({ ...official, ...replacement })).toBeFalse();
  }
});

test('staged native builds retain their exact vendor identity without granting runtime access', () => {
  for (const candidate of builds.filter(row => !row.qualified)) {
    expect(candidate.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.cdhash).toMatch(/^[a-f0-9]{40}$/);
    expect(qualifiedDesktopRelease(candidate)).toBeFalse();
  }
});
