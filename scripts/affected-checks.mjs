import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function selectChecks(load) {
  try {
    const { paths, packages, sharedInputs } = load();
    if (!paths.length) return 'full';
    const names = new Set();
    for (const path of paths) {
      const pkg = packages.find((entry) => path.startsWith(`${entry.path}/`));
      if (!pkg || typeof pkg.name !== 'string' || !/^[\w@/.-]+$/.test(pkg.name)) return 'full';
      const relative = path.slice(pkg.path.length + 1);
      if (!/^(src|test|tests)\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/.test(relative)) return 'full';
      if (/(^|\/)(scripts?|data|fixtures|__fixtures__|config)(\/|\.)|(^|\/)[^/]*config[^/]*\./i.test(relative)) return 'full';
      if (sharedInputs.some((input) => path.startsWith(input.split('*')[0]))) return 'full';
      names.add(pkg.name);
    }
    return [['pnpm', 'exec', 'turbo', 'run', 'test', ...[...names].sort().map((name) => `--filter=...${name}`)]];
  } catch {
    return 'full';
  }
}

export function selectRefs(base, head) {
  return selectChecks(() => {
    if (!base || !head || base.startsWith('-') || head.startsWith('-')) throw new Error('Two refs required');
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    const baseSha = git('rev-parse', '--verify', `${base}^{commit}`).trim();
    const headSha = git('rev-parse', '--verify', `${head}^{commit}`).trim();
    const paths = git('diff', '--name-only', '--no-renames', '-z', baseSha, headSha, '--').split('\0').filter(Boolean);
    const manifests = git('ls-tree', '-r', '--name-only', headSha).split('\n').filter((path) => /^(packages|apps|tests|plugins)\/[^/]+\/package.json$|^examples\/plugins\/[^/]+\/package.json$/.test(path));
    const packages = manifests.map((path) => ({ path: path.slice(0, -13), name: JSON.parse(git('show', `${headSha}:${path}`)).name }));
    const turbo = JSON.parse(git('show', `${headSha}:turbo.json`));
    const sharedInputs = Object.values(turbo.tasks).flatMap((task) => task.inputs ?? []).filter((input) => input.includes('$TURBO_ROOT$/')).map((input) => input.split('$TURBO_ROOT$/')[1]);
    return { paths, packages, sharedInputs };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const run = args[0] === '--run';
  const [base, head] = run ? args.slice(1) : args;
  const selected = selectRefs(base, head);
  if (!run) console.log(JSON.stringify(selected));
  else {
    const commands = selected === 'full' ? [['pnpm', 'test']] : selected;
    for (const [command, ...argv] of commands) {
      const result = spawnSync(command, argv, { stdio: 'inherit' });
      if (result.error || result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
