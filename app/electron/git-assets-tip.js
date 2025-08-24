// Node helpers to "lock from assets-tip" and "publish to assets-tip then unlock"

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(repo, cmd, args, { allowFail = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: cwd || repo,
      env: process.env,
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => {
      if (code !== 0 && !allowFail) {
        return reject(new Error((err || out || '').trim() || `${cmd} ${args.join(' ')} failed (${code})`));
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

async function fetchOrigin(repo, refs = []) {
  // Keep it quiet & fast; ensure assets-tip exists locally if used
  const args = ['fetch', '-q', 'origin', ...refs];
  await run(repo, 'git', args);
}

async function ensureCleanPaths(repo, paths) {
  if (!paths.length) return;
  // List changed (staged or unstaged) files under the given paths
  const { stdout } = await run(repo, 'git', ['diff', '--name-only', '--', ...paths]);
  const changed = stdout.trim().split('\n').filter(Boolean);
  if (changed.length) {
    throw new Error(`These files have local changes (commit or stash first): ${changed.join(', ')}`);
  }
  // Also ensure nothing staged for commit specifically for those paths
  const { stdout: cached } = await run(repo, 'git', ['diff', '--cached', '--name-only', '--', ...paths]);
  const staged = cached.trim().split('\n').filter(Boolean);
  if (staged.length) {
    throw new Error(`These files are staged (commit or unstage first): ${staged.join(', ')}`);
  }
}

async function existsOnRef(repo, ref, file) {
  const spec = `${ref}:${file}`;
  const { code } = await run(repo, 'git', ['cat-file', '-e', spec], { allowFail: true });
  return code === 0;
}

async function revParseBlob(repo, revColonPath) {
  const { stdout } = await run(repo, 'git', ['rev-parse', revColonPath]);
  return stdout.trim();
}

async function currentBranch(repo) {
  const { stdout } = await run(repo, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

async function shortHead(repo) {
  const { stdout } = await run(repo, 'git', ['rev-parse', '--short', 'HEAD']);
  return stdout.trim();
}

function uniqueWorktreeDir(repo, name = '.wt-assets-tip') {
  // Keep temp alongside repo to avoid long paths
  const base = path.join(repo, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return base;
}

/**
 * LOCK (multi-file):
 * 1) fetch origin
 * 2) ensure files are clean
 * 3) for files that exist on tipRef, checkout those blobs into current branch, commit once
 * 4) git lfs lock --json for each path
 * Returns: [{ path, json }]
 */
async function lockMany(repo, paths, { tipRef = 'origin/assets-tip' } = {}) {
  const files = Array.from(new Set(paths)).filter(Boolean);
  if (!files.length) return [];

  await fetchOrigin(repo, ['assets-tip']);
  await ensureCleanPaths(repo, files);

  // Determine which of these exist on assets-tip
  const toSync = [];
  for (const f of files) {
    if (await existsOnRef(repo, tipRef, f)) toSync.push(f);
  }

  if (toSync.length) {
    // Bring those paths from assets-tip into our branch, then commit once
    await run(repo, 'git', ['checkout', tipRef, '--', ...toSync]);
    await run(repo, 'git', ['add', '--', ...toSync]);
    await run(repo, 'git', ['commit', '-m', `Sync ${toSync.length} asset(s) from ${tipRef} before locking`]);
  }

  // Now lock each file (JSON per file)
  const results = [];
  for (const f of files) {
    const { stdout } = await run(repo, 'git', ['lfs', 'lock', f, '--json']);
    results.push({ path: f, json: JSON.parse(stdout) });
  }
  return results;
}

/**
 * UNLOCK (multi-file):
 * 1) fetch origin
 * 2) create temp worktree at origin/assets-tip
 * 3) stage exact HEAD blobs for all files into that worktree index (update-index --cacheinfo)
 * 4) commit once; push --ff-only
 * 5) git lfs unlock --json per file (supports {force})
 * Returns: [{ path, json }]
 */
async function unlockMany(repo, paths, { tipBranch = 'assets-tip', force = false } = {}) {
  const files = Array.from(new Set(paths)).filter(Boolean);
  if (!files.length) return [];

  await fetchOrigin(repo, [tipBranch]);

  // Resolve blobs for all files up-front; fail early if any missing
  const blobs = new Map();
  for (const f of files) {
    const spec = `HEAD:${f}`;
    const blob = await revParseBlob(repo, spec).catch(() => null);
    if (!blob) throw new Error(`File '${f}' not present in HEAD`);
    blobs.set(f, blob);
  }

  // Create a temporary worktree to update assets-tip without switching branches
  const wt = uniqueWorktreeDir(repo);
  // If exists from a crash, remove and proceed
  try { await run(repo, 'git', ['worktree', 'remove', '-f', wt], { allowFail: true }); } catch (_) {}
  await run(repo, 'git', ['worktree', 'add', '-f', '--detach', wt, `origin/${tipBranch}`]);

  const branchName = tipBranch;
  const wtOpts = { cwd: wt };
  await run(repo, 'git', ['checkout', '-q', '-B', branchName, `origin/${tipBranch}`], wtOpts);

  // Stage each blob into index without writing files to disk
  for (const [f, blob] of blobs) {
    // Ensure parent directory exists in working tree so index can record the path
    const dir = path.dirname(path.join(wt, f));
    if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await run(repo, 'git', ['update-index', '--add', '--cacheinfo', '100644', blob, f], wtOpts);
  }

  const srcBranch = await currentBranch(repo);
  const srcShort = await shortHead(repo);
  await run(repo, 'git', ['commit', '-m', `Update ${files.length} asset(s) from ${srcBranch} @ ${srcShort}`], wtOpts);

  // Push fast-forward only (linear history). If it fails, bubble up an error (user can retry).
  await run(repo, 'git', ['push', '--ff-only', 'origin', branchName], wtOpts);

  // Clean up worktree
  await run(repo, 'git', ['worktree', 'remove', '-f', wt], { allowFail: true });

  // Now unlock each file (optionally --force)
  const unlockArgs = force ? ['--force'] : [];
  const results = [];
  for (const f of files) {
    const { stdout } = await run(repo, 'git', ['lfs', 'unlock', f, '--json', ...unlockArgs]);
    results.push({ path: f, json: JSON.parse(stdout) });
  }
  return results;
}

// Convenience single-file wrappers
async function lockOne(repo, file, opts) {
  const res = await lockMany(repo, [file], opts);
  return res[0];
}
async function unlockOne(repo, file, opts) {
  const res = await unlockMany(repo, [file], opts);
  return res[0];
}

module.exports = {
  lockMany,
  unlockMany,
  lockOne,
  unlockOne,
};
