// Node helpers to "lock from assets-tip" and "publish to assets-tip then unlock"

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normPath, joinRepo } = require('./paths');

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

async function isPathClean(repo, p) {
  const a = (await run(repo, 'git', ['diff', '--name-only', '--', p])).stdout.trim();
  const b = (await run(repo, 'git', ['diff', '--cached', '--name-only', '--', p])).stdout.trim();
  return !a && !b;
}

async function existsOnRef(repo, ref, file) {
  const p = normPath(file);
  const spec = `${ref}:${p}`;
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

async function lockMany(repo, paths, { tipRef = 'origin/assets-tip' } = {}) {
  const files = Array.from(new Set(paths.map(normPath))).filter(Boolean);
  if (!files.length) return [];

  await fetchOrigin(repo, ['assets-tip']);

  // Build "candidates" and skip noisy ones (missing/dirty) PER FILE
  const candidates = [];
  for (const f of files) {
    const abs = joinRepo(repo, f);
    if (!fs.existsSync(abs)) continue;
    if (!(await isPathClean(repo, f))) {
      // skip: has local changes staged/unstaged
      continue;
    }
    candidates.push(f);
  }
  if (!candidates.length) return [];

  // Determine which candidates differ vs tipRef and need a sync commit
  const toUpdate = [];
  for (const f of candidates) {
    if (await existsOnRef(repo, tipRef, f)) {
      const [tipOid, headOid] = await Promise.all([
        revParseBlob(repo, `${tipRef}:${f}`),
        revParseBlob(repo, `HEAD:${f}`).catch(() => ''), // '' if missing in HEAD
      ]);
      if (tipOid !== headOid) toUpdate.push(f);
    }
  }

  if (toUpdate.length) {
    await run(repo, 'git', ['checkout', tipRef, '--', ...toUpdate]);
    await run(repo, 'git', ['add', '--', ...toUpdate]);

    const subject =
      toUpdate.length === 1
        ? `Sync ${toUpdate[0]} from ${tipRef} before locking`
        : `Sync ${toUpdate.length} assets from ${tipRef} before locking`;
    const body = toUpdate.slice(0, 50).map(f => `- ${f}`).join('\n');
    const commitArgs = ['commit', '-m', subject];
    if (body) commitArgs.push('-m', body);
    await run(repo, 'git', commitArgs);
  }

  // Try to lock each candidate independently; continue on errors
  const ok = [], errors = [];
  for (const f of candidates) {
    try {
      const { stdout } = await run(repo, 'git', ['lfs', 'lock', f, '--json']);
      ok.push({ path: normPath(f), json: JSON.parse(stdout) });
    } catch (err) {
      errors.push({ path: normPath(f), message: err.message || String(err) });
    }
  }
  return { ok, errors };
}

async function unlockMany(repo, paths, { tipBranch = 'assets-tip', force = false } = {}) {
  const files = Array.from(new Set(paths.map(normPath))).filter(Boolean);
  if (!files.length) return [];

  const tipRef = `origin/${tipBranch}`;
  await fetchOrigin(repo, [tipBranch]);

  // Decide which files we can publish (present in HEAD) and need publishing (new/different)
  const toPublish = [];
  for (const f of files) {
    const headBlob = await revParseBlob(repo, `HEAD:${normPath(f)}`).catch(() => null);
    if (!headBlob) {
      // no blob in HEAD → nothing to publish for this file; we will still attempt unlock later
      continue;
    }
    const onTip = await existsOnRef(repo, tipRef, f);
    if (!onTip) {
      toPublish.push([normPath(f), headBlob]);
    } else {
      const tipBlob = await revParseBlob(repo, `${tipRef}:${f}`);
      if (tipBlob !== headBlob) toPublish.push([normPath(f), headBlob]);
    }
  }

  if (toPublish.length) {
    const wt = uniqueWorktreeDir(repo);
    try {
      await run(repo, 'git', ['worktree', 'remove', '-f', wt], { allowFail: true });
      await run(repo, 'git', ['worktree', 'add', '-f', '--detach', wt, tipRef]);

      const wtOpts = { cwd: wt };
      await run(repo, 'git', ['checkout', '-q', '-B', tipBranch, tipRef], wtOpts);

      for (const [f, headBlob] of toPublish) {
        const absDir = path.dirname(joinRepo(wt, f));
        if (absDir && absDir !== '.' && !fs.existsSync(absDir)) {
          fs.mkdirSync(absDir, { recursive: true });
        }
        await run(repo, 'git', ['update-index', '--add', '--cacheinfo', '100644', headBlob, f], wtOpts);
      }

      const srcBranch = await currentBranch(repo);
      const srcShort  = await shortHead(repo);
      const subject =
        toPublish.length === 1
          ? `Update ${toPublish[0][0]} from ${srcBranch} @ ${srcShort}`
          : `Update ${toPublish.length} asset(s) from ${srcBranch} @ ${srcShort}`;
      const body = toPublish.slice(0,50).map(([f]) => `- ${f}`).join('\n');

      const commitArgs = ['commit', '-m', subject];
      if (body) commitArgs.push('-m', body);
      await run(repo, 'git', commitArgs, wtOpts);

      await run(repo, 'git', ['push', 'origin', tipBranch], wtOpts);
    } finally {
      await run(repo, 'git', ['worktree', 'remove', '-f', wt], { allowFail: true });
    }
  }

  // Try to unlock each file independently; continue on errors

  const unlockArgs = force ? ['--force'] : [];
  const ok = [], errors = [];

  for (const f of files) {
    try {
      const { stdout } = await run(repo, 'git', ['lfs', 'unlock', normPath(f), '--json', ...unlockArgs]);
      ok.push({ path: normPath(f), json: JSON.parse(stdout) });
    } catch (err) {
      errors.push({ path: normPath(f), message: err.message || String(err) });
    }
  }
  return { ok, errors };
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
