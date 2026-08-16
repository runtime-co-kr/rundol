'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const eventStore = require(path.join(root, 'src', 'event-store.js'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-event-store-'));

function event(clientId, index, at) {
  return {
    schemaVersion: 1,
    eventId: `EVT-${clientId}-${String(index).padStart(6, '0')}`,
    type: 'lease.acquired',
    clientId,
    occurredAt: at || new Date(1700000000000 + index * 1000).toISOString()
  };
}

async function main() {
  const eventsRoot = path.join(temporary, 'events');

  // 평면 배치와 파일명: lease는 events/ 바로 아래, 기존 문법과 동일해야 한다.
  const first = eventStore.appendEvent(eventsRoot, 'lease', 'crm', 'laptop-a', event('laptop-a', 1));
  assert.strictEqual(first, path.join(eventsRoot, 'lease-crm-laptop-a-000001.jsonl'));

  // 서브디렉터리 배치: run은 events/run/ 아래, runId 없는 append는 거부한다.
  assert.throws(() => eventStore.appendEvent(eventsRoot, 'run', 'crm', 'laptop-a', event('laptop-a', 1)), /runId가 필요합니다/u);
  const runId = 'RUN-0123456789ABCDEF0123';
  const runFile = eventStore.appendEvent(eventsRoot, 'run', 'crm', 'laptop-a', event('laptop-a', 1), { runId });
  assert.strictEqual(runFile, path.join(eventsRoot, 'run', `run-crm-laptop-a-${runId}-000001.jsonl`));

  // 등록되지 않은 kind는 거부한다.
  assert.throws(() => eventStore.readEvents(eventsRoot, 'unknown', 'crm'), /등록되지 않은 이벤트 종류/u);

  // 세그먼트 롤오버: 500건에서 다음 세그먼트로 넘어간다.
  for (let index = 2; index <= 501; index += 1) eventStore.appendEvent(eventsRoot, 'lease', 'crm', 'laptop-a', event('laptop-a', index));
  assert(fs.existsSync(path.join(eventsRoot, 'lease-crm-laptop-a-000002.jsonl')));
  const firstSegment = fs.readFileSync(path.join(eventsRoot, 'lease-crm-laptop-a-000001.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean);
  assert.strictEqual(firstSegment.length, 500);

  // 정렬: 다른 클라이언트 샤드에 흩어진 이벤트를 occurredAt·eventId로 병합 정렬한다.
  eventStore.appendEvent(eventsRoot, 'lease', 'crm', 'desk-b', event('desk-b', 0, new Date(1600000000000).toISOString()));
  const events = eventStore.readEvents(eventsRoot, 'lease', 'crm');
  assert.strictEqual(events.length, 502);
  assert.strictEqual(events[0].clientId, 'desk-b');

  // 파일명과 이벤트 clientId 불일치는 오류다.
  const forged = path.join(eventsRoot, 'lease-crm-desk-b-000002.jsonl');
  fs.writeFileSync(forged, `${JSON.stringify(event('laptop-a', 999))}\n`, 'utf8');
  assert.throws(() => eventStore.readEvents(eventsRoot, 'lease', 'crm'), /clientId가 파일명과 일치하지 않습니다/u);
  fs.rmSync(forged);

  // 동시성: 같은 client 샤드에 4개 프로세스가 락 경유로 각 150건 append → 600줄 전부 온전, 롤오버 정확.
  const concurrentRoot = path.join(temporary, 'concurrent');
  const lockDirectory = path.join(temporary, 'locks');
  const worker = path.join(temporary, 'worker.js');
  fs.writeFileSync(worker, [
    `const eventStore = require(${JSON.stringify(path.join(root, 'src', 'event-store.js'))});`,
    'const [eventsRoot, lockDirectory, clientId, count, offset] = process.argv.slice(2);',
    'for (let index = 0; index < Number(count); index += 1) {',
    '  eventStore.appendEvent(eventsRoot, "lease", "crm", clientId, {',
    '    schemaVersion: 1,',
    '    eventId: `EVT-${clientId}-${offset}-${String(index).padStart(6, "0")}`,',
    '    type: "lease.acquired", clientId, occurredAt: new Date().toISOString()',
    '  }, { lockDirectory });',
    '}'
  ].join('\n'), 'utf8');
  await Promise.all([0, 1, 2, 3].map((offset) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, concurrentRoot, lockDirectory, 'laptop-a', '150', String(offset)], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${offset} exit ${code}`))));
    child.on('error', reject);
  })));
  const segments = fs.readdirSync(concurrentRoot).filter((name) => name.startsWith('lease-crm-laptop-a-')).sort();
  assert.deepStrictEqual(segments, ['lease-crm-laptop-a-000001.jsonl', 'lease-crm-laptop-a-000002.jsonl']);
  const lines = segments.flatMap((name) => fs.readFileSync(path.join(concurrentRoot, name), 'utf8').split(/\r?\n/u).filter(Boolean));
  assert.strictEqual(lines.length, 600);
  for (const line of lines) JSON.parse(line);
  assert.strictEqual(fs.readFileSync(path.join(concurrentRoot, segments[0]), 'utf8').split(/\r?\n/u).filter(Boolean).length, 500);

  process.stdout.write('event store tests passed\n');
}

module.exports = main().finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
