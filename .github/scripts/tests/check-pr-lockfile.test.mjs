import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('passes when the same PR introduces the release broker workspace', () => {
  const result = checkLockfile([
    { filename: 'pnpm-lock.yaml', status: 'modified' },
    { filename: 'packages/release-broker/package.json', status: 'added' },
  ], 'someuser', 'feature/release-broker');
  assert.equal(result.passed, true);
});

test('fails when an existing release broker manifest changes with the lockfile', () => {
  const result = checkLockfile([
    { filename: 'pnpm-lock.yaml', status: 'modified' },
    { filename: 'packages/release-broker/package.json', status: 'modified' },
  ], 'someuser', 'fix/release-broker');
  assert.equal(result.passed, false);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});
