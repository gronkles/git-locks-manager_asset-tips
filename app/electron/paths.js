const path = require('path');

function normPath(p) {
  // stringify, convert backslashes → slashes, strip leading ./, collapse .. and extra slashes
  return path.posix.normalize(String(p).replace(/\\/g, '/').replace(/^\.\/+/, ''));
}

function joinRepo(repo, rel) {
  // join safely on Windows using OS separators, even if rel is POSIX
  return path.join(repo, ...normPath(rel).split('/'));
}

module.exports = { normPath, joinRepo };