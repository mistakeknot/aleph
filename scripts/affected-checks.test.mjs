import assert from 'node:assert/strict';
import test from 'node:test';
import { selectChecks } from './affected-checks.mjs';

const packages = [{ path: 'packages/a', name: '@bb/a' }, { path: 'packages/b', name: '@bb/b' }];
const select = (paths) => selectChecks(() => ({ paths, packages, sharedInputs: [] }));
test('package source selects that package and dependents through Turbo', () => {
  assert.deepEqual(select(['packages/a/src/a.ts']), [['pnpm', 'exec', 'turbo', 'run', 'test', '--filter=...@bb/a']]);
});
for (const path of ['pnpm-lock.yaml', 'scripts/ci-release-check.sh', 'turbo.json', 'vitest.config.ts', 'package.json', '.npmrc', 'docs/unknown.md', 'packages/a/data/example.json', 'packages/a/vitest.config.ts', 'packages/missing/src/a.ts', 'packages/a/scripts/build.ts']) {
  test(`${path} requires full suite`, () => assert.equal(select([path]), 'full'));
}
test('selector errors require full suite', () => {
  assert.equal(selectChecks(() => { throw new Error('git failed'); }), 'full');
});
test('shared task inputs require full suite', () => {
  assert.equal(selectChecks(() => ({ paths: ['packages/a/src/a.ts'], packages, sharedInputs: ['packages/a/src/**'] })), 'full');
});
test('empty changes require full suite', () => assert.equal(select([]), 'full'));
test('invalid refs print a full fallback in the CLI', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, ['scripts/affected-checks.mjs', 'missing-base', 'missing-head'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(JSON.parse(output), 'full');
});
