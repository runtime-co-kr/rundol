'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function repositoryDirectory(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function runGit(args, options) {
  const settings = options || {};
  const safeDirectory = settings.cwd ? repositoryDirectory(settings.cwd).replace(/\\/g, '/') : null;
  const gitArgs = ['-c', 'http.version=HTTP/1.1'];
  if (safeDirectory) gitArgs.push('-c', `safe.directory=${safeDirectory}`);
  gitArgs.push(...args);
  const result = spawnSync('git', gitArgs, {
    cwd: settings.cwd,
    input: settings.input,
    encoding: 'utf8',
    env: Object.assign({}, process.env, settings.env || {})
  });
  if (result.error) throw new Error(`Git을 실행할 수 없습니다: ${result.error.message}`);
  if (result.status !== 0 && !settings.allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} 실패${detail ? `: ${detail}` : ''}`);
  }
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function refExists(root, ref) {
  return runGit(['show-ref', '--verify', '--quiet', ref], { cwd: root, allowFailure: true }).status === 0;
}

function gitRoot(start) {
  return runGit(['rev-parse', '--show-toplevel'], { cwd: start }).stdout;
}

module.exports = { runGit, refExists, gitRoot };
