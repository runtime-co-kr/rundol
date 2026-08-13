'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit } = require('./git');
const { config: settingsConfig, syncSettings, saveSettings } = require('./settings');

function clientId() {
  return String(process.env.RUNDOL_CLIENT_ID || os.hostname() || 'client')
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'client';
}

function eventMaximum(directory, project, documentType) {
  if (!fs.existsSync(directory)) return 0;
  let maximum = 0;
  for (const name of fs.readdirSync(directory).filter((value) => value.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === 'document.number.reserved' && event.project === project && event.documentType === documentType) {
        maximum = Math.max(maximum, Number(event.number) || 0);
      }
    }
  }
  return maximum;
}

function reserveDocumentId(root, project, documentType, localMaximum) {
  const settings = settingsConfig(root);
  if (!settings || settings.domain !== 'workspace') return `${documentType}-${String(localMaximum + 1).padStart(3, '0')}`;
  const remote = 'origin';
  const remotes = runGit(['remote'], { cwd: root }).stdout.split(/\r?\n/).filter(Boolean);
  if (!remotes.includes(remote)) return `${documentType}-${String(localMaximum + 1).padStart(3, '0')}`;
  const remoteRef = `refs/remotes/${remote}/${settings.branch}`;
  const directory = path.join(settings.worktree, 'events', 'sequences');
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    syncSettings(root, { remote, push: true });
    const number = Math.max(localMaximum, eventMaximum(directory, project, documentType)) + 1;
    if (number > 999) throw new Error(`${documentType} 문서 번호 999를 초과할 수 없습니다.`);
    const id = `${documentType}-${String(number).padStart(3, '0')}`;
    const event = {
      schemaVersion: 1, eventId: `EVT-${crypto.randomUUID()}`, type: 'document.number.reserved',
      project, documentType, number, documentId: id, clientId: clientId(), reservedAt: new Date().toISOString()
    };
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `document-sequence-${project}-${documentType}-${event.clientId}-${event.eventId.slice(4)}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    saveSettings(root);
    const pushed = runGit(['push', remote, `${settings.ref}:${settings.ref}`], { cwd: root, allowFailure: true });
    if (pushed.status === 0) {
      const commit = runGit(['rev-parse', settings.ref], { cwd: root }).stdout;
      runGit(['update-ref', remoteRef, commit], { cwd: root });
      return id;
    }
    const detail = `${pushed.stderr}\n${pushed.stdout}`;
    if (!/fetch first|non-fast-forward|rejected/i.test(detail)) throw new Error(`문서 번호 예약 push 실패: ${detail.trim()}`);
    const fetched = runGit(['fetch', '--no-tags', remote, `+${settings.ref}:${remoteRef}`], { cwd: root, allowFailure: true });
    if (fetched.status !== 0) throw new Error(`문서 번호 예약 갱신 실패: ${(fetched.stderr || fetched.stdout).trim()}`);
    runGit(['reset', '--hard', remoteRef], { cwd: settings.worktree });
  }
  throw new Error('동시 문서 번호 예약이 반복되어 실패했습니다. 잠시 후 다시 시도하세요.');
}

module.exports = { reserveDocumentId };
