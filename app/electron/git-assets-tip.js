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
  const toUpdate = [];
  for (const f of files) {
    if (await existsOnRef(repo, tipRef, f)) {
      const [tipOid, headOid] = await Promise.all([
        revParseBlob(repo, `${tipRef}:${f}`),              // blob on assets-tip
        revParseBlob(repo, `HEAD:${f}`).catch(() => ''),   // blob on our HEAD ('' if missing)
      ]);
      if (tipOid !== headOid) toUpdate.push(f);            // only when different
    }
  }

  if (toUpdate.length) {
    await run(repo, 'git', ['checkout', tipRef, '--', ...toUpdate]);
    await run(repo, 'git', ['add', '--', ...toUpdate]);
    
    const subject =
      toUpdate.length === 1
        ? `Sync ${toUpdate[0]} from ${tipRef} before locking`
        : `Sync ${toUpdate.length} assets from ${tipRef} before locking`;

    const body = toUpdate.slice(0, 50)  // cap the list to avoid mega messages
      .map(f => `- ${f}`)
      .join('\n');

    const commitArgs = ['commit', '-m', subject];
    if (body) commitArgs.push('-m', body);

    await run(repo, 'git', commitArgs);
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
 * 4) commit once; push
 * 5) git lfs unlock --json per file (supports {force})
 * Returns: [{ path, json }]
 */
async function unlockMany(repo, paths, { tipBranch = 'assets-tip', force = false } = {}) {
  const files = Array.from(new Set(paths)).filter(Boolean);
  if (!files.length) return [];

  const tipRef = `origin/${tipBranch}`;
  await fetchOrigin(repo, [tipBranch]);

  // Build list of files we actually need to publish (new on tip OR different blob)
  const toPublish = [];
  for (const f of files) {
    const headBlob = await revParseBlob(repo, `HEAD:${f}`).catch(() => null);
    if (!headBlob) throw new Error(`File '${f}' not present in HEAD`);

    const onTip = await existsOnRef(repo, tipRef, f);
    if (!onTip) {
      // New file on tip → needs publishing
      toPublish.push([f, headBlob]);
    } else {
      const tipBlob = await revParseBlob(repo, `${tipRef}:${f}`);
      if (tipBlob !== headBlob) {
        // Different content → needs publishing
        toPublish.push([f, headBlob]);
      }
    }
  }

  // Only create a worktree / commit / push if something actually changed
  if (toPublish.length) {
    const wt = uniqueWorktreeDir(repo);
    try {
      await run(repo, 'git', ['worktree', 'remove', '-f', wt], { allowFail: true });
      await run(repo, 'git', ['worktree', 'add', '-f', '--detach', wt, tipRef]);

      const wtOpts = { cwd: wt };
      await run(repo, 'git', ['checkout', '-q', '-B', tipBranch, tipRef], wtOpts);

      // Stage exact blobs without touching WT bytes
      for (const [f, headBlob] of toPublish) {
        const absDir = path.dirname(path.join(wt, f));
        if (absDir && absDir !== '.' && !fs.existsSync(absDir)) {
          fs.mkdirSync(absDir, { recursive: true });
        }
        await run(repo, 'git', ['update-index', '--add', '--cacheinfo', '100644', headBlob, f], wtOpts);
      }

      const srcBranch = await currentBranch(repo);
      const srcShort  = await shortHead(repo);

      // Nice subject/body with file list (optional: cap the list length)
      const subject =
        toPublish.length === 1
          ? `Update ${toPublish[0][0]} from ${srcBranch} @ ${srcShort}`
          : `Update ${toPublish.length} asset(s) from ${srcBranch} @ ${srcShort}`;
      const body = toPublish
        .slice(0, 50)
        .map(([f]) => `- ${f}`)
        .join('\n');

      const commitArgs = ['commit', '-m', subject];
      if (body) commitArgs.push('-m', body);
      await run(repo, 'git', commitArgs, wtOpts);

      // Plain push is already fast-forward-only unless forced server-side
      await run(repo, 'git', ['push', 'origin', tipBranch], wtOpts);
    } finally {
      // Always try to clean up the worktree
      await run(repo, 'git', ['worktree', 'remove', '-f', wt], { allowFail: true });
    }
  }

  // Always proceed to unlock the requested files, even if nothing changed
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
