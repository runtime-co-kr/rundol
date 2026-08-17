#!/usr/bin/env node
'use strict';

const path = require('path');
const { doctor } = require('../src/doctor');

const VERSION = require('../package.json').version;
const CLI_STARTED_AT = Date.now();
let DEBUG_CONTEXT = null;

function usage() {
  return `rdl ${VERSION}

Usage:
  rdl init [project-key] [--name <project-name>] [--project <key>] [--remote <name>] [--new] [--guided]
           [--profile <name>] [--defaults] [--questions] [--primary-branch <name>] [--trait <name>] [--root <path>] [--json]
  rdl attach [project-key] [--remote <name>] [--root <path>] [--json]
  rdl detach <project-key> [--remote <name>] [--root <path>] [--json]
  rdl project add <project-key> --name <project-name> [--profile <name>] [--root <path>] [--json]
  rdl project profile --project <key> --profile <lean|product|service|platform|assured> [--trait <name>] [--required <TYPE,...>] [--recommended <TYPE,...>] [--on-demand <TYPE,...>] [--disabled <TYPE,...>] [--json]
  rdl contract show|next|check|trace --project <key> [--json]
  rdl contract diagram --project <key> [--write] [--json]
  rdl contract plan|set --project <key> --profile <name> [--enforcement <advisory|checkpoint>] [--json]
  rdl check [ARTIFACT-ID] [--root <path>] [--project <key>] [--json] [--strict] [--implementation]
  rdl check --links [--root <path>]
  rdl check --tasks [--root <path>]
  rdl git init|boundary [--root <path>] [--project <key>] [--json]
  rdl refresh [--root <path>] [--project <key>] [--json]
  rdl save [--root <path>] [--project <key>] [--json]
  rdl obsidian init [--root <path>] [--project <key>] [--force] [--json]
  rdl check --structure [--root <path>] [--project <key>] [--json]
  rdl cleanup [--root <path>] [--project <key>] [--apply] [--json]
  rdl skill install [--force] [--json]
  rdl settings migrate [--root <path>] [--json]
  rdl workspace show|check|sync|migrate [--root <path>] [--json]
  rdl member add <이름> --role <ROLE-ID> --organization <소속> --account <업무 계정> --responsibility <책임 영역> [--member <MEMBER-ID>] [--project <key>] [--json]
  rdl member set <MEMBER-ID|STAKEHOLDER-ID> [--name <이름>] [--role <ROLE-ID>] [--organization <소속>] [--account <계정>] [--responsibility <책임>] [--status <상태>] [--project <key>] [--json]
  rdl member list [--project <key>] [--json]
  rdl client register <client-id> --name <name> --type <device|agent|service> --owner <MEMBER-ID> [--json]
  rdl client list|show <client-id>|enable <client-id>|disable <client-id> [--json]
  rdl lease acquire|renew|release <DOCUMENT-ID> --project <key> --client-id <id> [--json]
  rdl lease list --project <key> [--json]
  rdl run start <절차이름> --project <key> --client-id <id> [--goal <목표>] [--request-id <REQ-ID>] [--json]
  rdl run next --run <RUN-ID> --project <key> [--json]
  rdl run step --run <RUN-ID> --project <key> --client-id <id> [--step <id>] [--exit <n>] [--artifact-id <ID>] [--force --reason <사유>] [--request-id <REQ-ID>] [--json]
  rdl run gate --run <RUN-ID> --project <key> --client-id <id> [--step <id>] [--force --reason <사유>] [--request-id <REQ-ID>] [--json]
  rdl run halt|resume|complete --run <RUN-ID> --project <key> --client-id <id> [--request-id <REQ-ID>] [--json]
  rdl run takeover --run <RUN-ID> --project <key> --client-id <id> [--force --reason <사유>] [--request-id <REQ-ID>] [--json]
  rdl run ownership resolve --run <RUN-ID> --project <key> --conflict <digest> --select <event-id> --client-id <id> --reason <사유> [--force] [--request-id <REQ-ID>] [--json]
  rdl run drive --run <RUN-ID> --project <key> --client-id <id> [--scheduled] [--request-id <REQ-ID>] [--json]
  rdl run operation resolve --run <RUN-ID> --project <key> --operation <operation-id> --conflict <digest> --select <event-id> --client-id <id> --reason <text> [--force] [--request-id <REQ-ID>] [--json]
  rdl run requests [--pending] [--json]
  rdl run request resume <REQ-ID> --client-id <id> [--json]
  rdl run list --project <key> [--json]
  rdl run log --run <RUN-ID> --project <key> [--json]
  rdl run procedures [--project <key>] [--json]
  rdl adapter run <name> --project <key> --run <RUN-ID> --step <id> --mode <author|verify> --client-id <id> [--json]
  rdl verify <ARTIFACT-ID> --project <key> --client-id <id> [--adapter <name>] [--lens <registry-id>]... [--run <RUN-ID>] [--request-id <REQ-ID>] [--json]
  rdl watch --project <key> [--remote] [--once] [--json]
  rdl task add <제목> --acceptance <완료조건> [--summary <설명>] [--owner <MEMBER-ID>]
                   [--reviewer <MEMBER-ID>] [--stakeholder <STAKEHOLDER-ID>]
                   [--priority <high|mid|low>] [--link <ARTIFACT-ID>] [--json]
  rdl task set <TASK-ID> [--project <key>] [--status <state>] [--owner <MEMBER-ID|null>]
                 [--external-ref <branch|pr|issue>=<값>] [--json]
                 반려는 --status cancelled --reason <사유> [--decided-by <MEMBER-ID>]
  rdl workset list [--project <key>] [--branch <name>] [--json]
  rdl index status|rebuild|clear [--root <path>] [--json]
  rdl task list [--project <key>] [--status <state>] [--open] [--json]
  rdl task acceptance <TASK-ID> <AC-ID> (--done|--undone) [--project <key>] [--json]
  rdl task migrate [--project <key>] [--client-id <id>] [--max-items <n>] [--json]
  rdl context [--root <path>] [--project <key>] [--json]
  rdl help [--json]
  rdl decision list [--project <key>] [--open] [--json]
  rdl decision request --kind <종류> --subject <대상> --question <질문> --option <id=설명>
                       --recommend <id> --because <근거> --blast <영향 범위> [--irreversible]
                       [--evidence <근거>] --client-id <id> [--project <key>] [--json]
  rdl decision answer <DEC-ID> --select <option-id> --member <MEMBER-ID> --reason <사유>
                      --client-id <id> [--project <key>] [--json]
  rdl decision kinds [--json]
  rdl delegation list [--project <key>] [--active] [--json]
  rdl delegation grant --kind <종류> --delegate <client-id> --member <MEMBER-ID> --reason <사유>
                       [--days <n>] --client-id <id> [--project <key>] [--json]
  rdl delegation revoke <DLG-ID> --member <MEMBER-ID> --reason <사유> --client-id <id>
                        [--project <key>] [--json]
  rdl doc create <TYPE> <제목> --owner <MEMBER-ID> --scope <단일-책임> --exclude <제외-범위>
                 [--function-id <기능-ID>] [--grouped --reason <합침-사유>] [--exclude <제외-범위>] [--related <ARTIFACT-ID>] [--project <key>] [--json]
  rdl doc migrate [--project <key>] [--apply] [--json]
  rdl doc identity [--project <key>] [--apply] [--json]
  rdl doc status [--project <key>] [--status <approved|stale|unapproved>] [--json]
  rdl doc approve <ARTIFACT-ID> --member <MEMBER-ID> --basis <read|verdict|check|delegated>[=<상세>]
                  --client-id <id> [--reason <사유>] [--project <key>] [--json]
  rdl doc history <ARTIFACT-ID> [--project <key>] [--json]
  rdl doc diff <ARTIFACT-ID> --since-approval [--project <key>] [--json]
  rdl sync [--root <path>] [--project <key>] [--remote <name>] [--no-push] [--request-id <REQ-ID>] [--json]
  rdl sync watch [--interval <seconds>] [--project <key>] [--no-push] [--once] [--request-id <REQ-ID>] [--json]
  rdl conflict list [--project <key>] [--json]
  rdl conflict resolve --strategy <ours|theirs> [--project <key>] [--json]
  rdl conflict clear [--project <key>] [--json]
  rdl action resolve <ACTION> [--json]
  rdl action record <ACTION> --actual-executor <cli|llm|hybrid> [--planned-executor <executor>]
                    [--artifact-id <ID>] [--task-id <ID>] [--fallback-reason <reason>] [--json]
  rdl debug record --input-tokens <n> --output-tokens <n> [--model <name>] [--provider <name>] [--unreported] [--json]
  rdl debug summary [--json]
  rdl doctor [--git-url <url>] [--json]
  rdl board [--root <path>] [--project <key>] [--port <number>] [--no-open] [--json]
  rdl --version
  rdl --help

Options:
  --root <path>  Rundol Workspace root. Defaults to the current directory or its parent Workspace.
  --project <key>  Select a project. Required when the Workspace has multiple projects.
  --name <name>  Project display name used by init and project add.
  --json         Print a stable machine-readable result.
  --new          Explicitly create a new Rundol workspace when discovery finds none.
  --guided       Interview for new-project settings in an interactive terminal.
  --profile      Select lean, product, service, platform, or assured document policy.
  --strict       Treat unresolved body wiki links as errors.
  --links        Print only reference-integrity diagnostics.
  --tasks        Print only task diagnostics.
  --open         열린 태스크(todo, doing, waiting, review)만 나열합니다.
  --defaults     결정하지 않고 권고 기본값을 수용한다고 명시적으로 선언합니다.
  --questions    결정해야 할 항목을 질문 목록으로 돌려주고 아무것도 만들지 않습니다.
  --acceptance   태스크 완료조건. 여러 번 지정할 수 있습니다.
  --reviewer     project.md에 등록된 검토 멤버. 여러 번 지정할 수 있습니다.
  --stakeholder  project.md에 등록된 이해관계자. 여러 번 지정할 수 있습니다.
  --link         연결할 문서 또는 문서 섹션. 여러 번 지정할 수 있습니다.
  --scope        문서가 책임지는 하나의 독립 검토 단위입니다.
  --exclude      인접하지만 이 문서가 책임지지 않는 범위입니다. 여러 번 지정할 수 있습니다.
  --function-id  REQ·SCR·MOD·API·TST가 추적하는 기능 ID입니다. 여러 번 지정할 수 있습니다.
  --force        기존 개인 Obsidian 설정 또는 Rundol이 관리하지 않는 스킬도 덮어씁니다.
  --port <n>     Local board port. Defaults to an available random port.
  --no-open      Start the board without opening a browser.
`;
}

function parseBoardArgs(argv) {
  const options = { root: process.cwd(), project: null, port: 0, open: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--json') options.json = true;
    else if (value === '--no-open') options.open = false;
    else if (value === '--root' || value === '--project' || value === '--port') {
      i += 1;
      if (!argv[i]) throw new Error(`${value} 값이 필요합니다.`);
      if (value === '--root') options.root = path.resolve(argv[i]);
      else if (value === '--project') options.project = argv[i];
      else {
        options.port = Number.parseInt(argv[i], 10);
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port는 0부터 65535 사이의 정수여야 합니다.');
      }
    } else if (value.startsWith('-')) throw new Error(`알 수 없는 옵션: ${value}`);
    else throw new Error(`rdl board에 위치 인수를 사용할 수 없습니다: ${value}`);
  }
  return options;
}

function parseWatchArgs(argv) {
  const options = { root: process.cwd(), project: null, remote: false, once: false, json: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!['--project', '--remote', '--once', '--json'].includes(value)) throw new Error(`rdl watch does not support this argument: ${value}`);
    if (seen.has(value)) throw new Error(`rdl watch option may be specified only once: ${value}`);
    seen.add(value);
    if (value === '--remote') options.remote = true;
    else if (value === '--once') options.once = true;
    else if (value === '--json') options.json = true;
    else {
      i += 1;
      if (!argv[i] || argv[i].startsWith('-')) throw new Error('--project <key> is required');
      options.project = argv[i];
    }
  }
  if (!options.project) throw new Error('rdl watch requires --project <key>');
  return options;
}

function parseOperationArgs(argv) {
  const options = { root: process.cwd(), project: null, name: null, profile: null, json: false, remote: 'origin', push: true, force: false, apply: false, write: false, once: false, done: false, undone: false, unreported: false, guided: false, new: false, status: undefined, owner: undefined, summary: '', scope: null, priority: 'mid', reviewers: [], stakeholders: [], links: [], acceptance: [], related: [], excludes: [], functionIds: [], traits: [], roles: [], lenses: [], member: null, organization: null, account: null, responsibility: null, policy: { required: [], recommended: [], onDemand: [], disabled: [] }, policySpecified: false, decisionOptions: [], evidence: [], irreversible: false, defaults: false, questions: false, active: false, externalRefs: [], basis: [], sinceApproval: false, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--json') options.json = true;
    else if (value === '--guided') options.guided = true;
    else if (value === '--new') options.new = true;
    else if (value === '--no-push') options.push = false;
    else if (value === '--force') options.force = true;
    else if (value === '--grouped') options.grouped = true;
    else if (value === '--apply') options.apply = true;
    else if (value === '--once') options.once = true;
    else if (value === '--scheduled') options.scheduled = true;
    else if (value === '--done') options.done = true;
    else if (value === '--undone') options.undone = true;
    else if (value === '--unreported') options.unreported = true;
    else if (value === '--pending') options.pending = true;
    else if (value === '--write') options.write = true;
    else if (value === '--open') options.open = true;
    else if (value === '--irreversible') options.irreversible = true;
    else if (value === '--defaults') options.defaults = true;
    else if (value === '--questions') options.questions = true;
    else if (value === '--active') options.active = true;
    else if (value === '--since-approval') options.sinceApproval = true;
    else if (['--root', '--project', '--name', '--profile', '--enforcement', '--trait', '--required', '--recommended', '--on-demand', '--disabled', '--type', '--remote', '--status', '--owner', '--summary', '--scope', '--exclude', '--function-id', '--priority', '--reviewer', '--stakeholder', '--link', '--acceptance', '--related', '--domain', '--feature', '--strategy', '--client-id', '--max-items', '--interval', '--input-tokens', '--output-tokens', '--cached-tokens', '--model', '--provider', '--client', '--git-url', '--planned-executor', '--actual-executor', '--artifact-id', '--task-id', '--fallback-reason', '--role', '--member', '--organization', '--account', '--responsibility', '--reason', '--decided-by', '--run', '--step', '--goal', '--exit', '--conflict', '--select', '--operation', '--request-id', '--adapter', '--lens', '--mode', '--kind', '--subject', '--question', '--option', '--recommend', '--because', '--blast', '--evidence', '--primary-branch', '--delegate', '--days', '--external-ref', '--branch', '--basis', '--delegation', '--supersedes'].includes(value)) {
      i += 1;
      if (!argv[i]) throw new Error(`${value} 값이 필요합니다.`);
      if (value === '--root') options.root = path.resolve(argv[i]);
      else if (value === '--project') options.project = argv[i];
      else if (value === '--name') options.name = argv[i];
      else if (value === '--profile') options.profile = argv[i];
      else if (value === '--enforcement') options.enforcement = argv[i];
      else if (value === '--remote') options.remote = argv[i];
      else if (value === '--status') options.status = argv[i];
      else if (value === '--owner') options.owner = argv[i] === 'null' ? null : argv[i];
      else if (value === '--summary') options.summary = argv[i];
      else if (value === '--reason') options.reason = argv[i];
      else if (value === '--decided-by') options.decidedBy = argv[i];
      else if (value === '--scope') options.scope = argv[i];
      else if (value === '--exclude') options.excludes.push(argv[i]);
      else if (value === '--function-id') options.functionIds.push(argv[i]);
      else if (value === '--priority') options.priority = argv[i];
      else if (value === '--reviewer') options.reviewers.push(argv[i]);
      else if (value === '--role') options.roles.push(argv[i]);
      else if (value === '--member') options.member = argv[i];
      else if (value === '--organization') options.organization = argv[i];
      else if (value === '--account') options.account = argv[i];
      else if (value === '--responsibility') options.responsibility = argv[i];
      else if (value === '--stakeholder') options.stakeholders.push(argv[i]);
      else if (value === '--link') options.links.push(argv[i]);
      else if (value === '--acceptance') options.acceptance.push(argv[i]);
      else if (value === '--related') options.related.push(argv[i]);
      else if (value === '--lens') options.lenses.push(argv[i]);
      else if (value === '--option') options.decisionOptions.push(argv[i]);
      else if (value === '--evidence') options.evidence.push(argv[i]);
      else if (value === '--external-ref') options.externalRefs.push(argv[i]);
      else if (value === '--basis') options.basis.push(argv[i]);
      else if (value === '--trait') options.traits.push(argv[i]);
      else if (['--required', '--recommended', '--on-demand', '--disabled'].includes(value)) {
        const state = value === '--on-demand' ? 'onDemand' : value.slice(2);
        options.policy[state].push(...argv[i].split(',').filter(Boolean));
        options.policySpecified = true;
      }
      else options[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[i];
    } else if (value.startsWith('-')) throw new Error(`알 수 없는 옵션: ${value}`);
    else options.positional.push(value);
  }
  return options;
}

// 사람이 읽는 출력은 객체를 건너뛴다. 그래서 목록 명령의 본체가 배열이라는 이유만으로
// 통째로 사라져 rdl member list와 rdl client list가 머리말만 찍고 끝났다.
// 최상위 배열은 그 명령이 보여주려는 것이므로 찍는다. 중첩 객체는 그대로 건너뛴다.
function summarizeEntry(value) {
  if (value === null || typeof value !== 'object') return String(value);
  return Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && typeof item !== 'object')
    .map(([key, item]) => `${key}=${item}`)
    .join(' ');
}
function printOperation(result, json) {
  if (json) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return; }
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      process.stdout.write(`${key}: ${value.length}건\n`);
      for (const entry of value) process.stdout.write(`  ${summarizeEntry(entry)}\n`);
      continue;
    }
    if (typeof value === 'object') continue;
    process.stdout.write(`${key}: ${value}\n`);
  }
}

function parseArgs(argv) {
  const options = { root: process.cwd(), project: null, json: false, strict: false, implementation: false, links: false, tasks: false, artifactId: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--json') options.json = true;
    else if (value === '--strict') options.strict = true;
    else if (value === '--implementation') options.implementation = true;
    else if (value === '--links') options.links = true;
    else if (value === '--tasks') options.tasks = true;
    else if (value === '--root' || value === '--project') {
      i += 1;
      if (!argv[i]) throw new Error('--root 값이 필요합니다.');
      if (value === '--root') options.root = path.resolve(argv[i]);
      else options.project = argv[i];
    } else if (value.startsWith('-')) throw new Error(`알 수 없는 옵션: ${value}`);
    else positional.push(value);
  }
  if (positional.length > 1) throw new Error('Artifact ID는 하나만 지정할 수 있습니다.');
  options.artifactId = positional[0] || null;
  return options;
}

function filterDiagnostics(diagnostics, options) {
  let result = diagnostics;
  if (options.artifactId) {
    result = result.filter((item) => item.artifactId === options.artifactId || item.target === options.artifactId);
  }
  if (options.links || options.tasks) {
    result = result.filter((item) =>
      (options.links && (item.category === 'link' || item.category === 'metadata')) ||
      (options.tasks && item.category === 'task'));
  }
  return result;
}

function printText(result) {
  for (const item of result.diagnostics) {
    const marker = item.severity === 'error' ? 'ERROR' : 'WARN ';
    const where = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : result.root;
    process.stdout.write(`${marker} ${item.code} ${where}\n  ${item.message}\n`);
  }
  const summary = result.summary;
  const marker = summary.errors === 0 ? '✓' : '✗';
  process.stdout.write(
    `\n${marker} 문서 ${summary.documents}개, 태스크 ${summary.tasks}개, 오류 ${summary.errors}개, 경고 ${summary.warnings}개 (${summary.durationMs}ms)\n`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const debugIndex = argv.indexOf('--debug');
  if (debugIndex >= 0) argv.splice(debugIndex, 1);
  if (debugIndex >= 0 || process.env.RUNDOL_DEBUG === '1') {
    const rootIndex = argv.indexOf('--root');
    const projectIndex = argv.indexOf('--project');
    DEBUG_CONTEXT = { root: rootIndex >= 0 && argv[rootIndex + 1] ? path.resolve(argv[rootIndex + 1]) : process.cwd(), project: projectIndex >= 0 ? argv[projectIndex + 1] : null, command: argv.slice(0, 3) };
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(usage());
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = argv.shift();
  // 발견 표면: 에이전트는 소스나 사람용 텍스트를 파싱하는 대신 이 둘로 명령과
  // 상태를 얻는다. help는 usage 정본에서 파생하므로 사본이 낡을 수 없다.
  if (command === 'help') {
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl help에는 위치 인수를 사용할 수 없습니다.');
    if (!options.json) { process.stdout.write(usage()); return 0; }
    process.stdout.write(`${JSON.stringify(require('../src/agent-context').commandCatalog(usage()), null, 2)}\n`);
    return 0;
  }
  if (command === 'context') {
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl context에는 위치 인수를 사용할 수 없습니다.');
    const context = require('../src/agent-context').agentContext(options.root, { project: options.project });
    if (options.json) { process.stdout.write(`${JSON.stringify(context, null, 2)}\n`); return 0; }
    process.stdout.write(`root: ${context.root}\nprojects: ${context.projects.map((item) => item.key).join(', ') || '(없음)'}\n`);
    process.stdout.write(`branch: ${context.branch.current || '(알 수 없음)'} (기본 ${context.branch.primary || '(알 수 없음)'})\n`);
    process.stdout.write(`diagnostics: 오류 ${context.diagnostics.errors} · 경고 ${context.diagnostics.warnings}\n`);
    process.stdout.write(`tasks: ${Object.entries(context.tasks.counts).map(([state, count]) => `${state} ${count}`).join(' · ') || '(없음)'}\n`);
    for (const action of context.next) process.stdout.write(`next: ${action}\n`);
    return 0;
  }
  if (command === 'decision') {
    const subcommand = argv.shift();
    if (!['list', 'request', 'answer', 'kinds'].includes(subcommand)) throw new Error('지원하는 결정 하위 명령은 list, request, answer, kinds입니다.');
    const options = parseOperationArgs(argv);
    const decision = require('../src/decision');
    if (subcommand === 'kinds') {
      const kinds = Object.entries(decision.KINDS).map(([kind, definition]) => ({ kind, family: definition.family, delegable: definition.delegable, summary: definition.summary }));
      printOperation({ families: decision.FAMILIES, kinds }, options.json);
      return 0;
    }
    if (subcommand === 'list') {
      if (options.positional.length) throw new Error('rdl decision list에는 위치 인수를 사용할 수 없습니다.');
      printOperation(decision.listDecisions(options.root, { project: options.project, open: options.open }), options.json);
      return 0;
    }
    if (subcommand === 'request') {
      if (options.positional.length) throw new Error('rdl decision request에는 위치 인수를 사용할 수 없습니다.');
      // 선택지는 닫힌 목록이고 권고안은 필수다. 명령 표면에서부터 그 계약을 지켜야
      // 권고 없는 질문이 기록으로 들어오지 않는다.
      const parsed = options.decisionOptions.map((entry) => {
        const separator = String(entry).indexOf('=');
        if (separator < 1) throw new Error(`--option은 <id>=<설명> 형식이어야 합니다: ${entry}`);
        return { id: entry.slice(0, separator), label: entry.slice(separator + 1) };
      });
      const result = decision.requestDecision(options.root, {
        project: options.project, clientId: options.clientId, kind: options.kind, subject: options.subject,
        question: options.question, options: parsed,
        recommendation: { option: options.recommend, because: options.because },
        impact: { reversible: !options.irreversible, blast: options.blast },
        evidence: options.evidence, rootRequestId: options.requestId
      });
      printOperation(result, options.json);
      return 0;
    }
    if (options.positional.length !== 1) throw new Error('rdl decision answer에는 DEC-ID 하나가 필요합니다.');
    const answered = decision.answerDecision(options.root, {
      project: options.project, clientId: options.clientId, decisionId: options.positional[0],
      selectedOption: options.select, answeredBy: options.member, reason: options.reason, supersedes: options.supersedes, rootRequestId: options.requestId
    });
    printOperation(answered, options.json);
    return 0;
  }
  if (command === 'index') {
    const subcommand = argv.shift();
    if (!['status', 'rebuild', 'clear'].includes(subcommand)) throw new Error('지원하는 인덱스 하위 명령은 status, rebuild, clear입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error(`rdl index ${subcommand}에는 위치 인수를 사용할 수 없습니다.`);
    const queryIndex = require('../src/query-index');
    // 인덱스는 삭제 가능한 캐시다. 지워도 데이터가 사라지지 않고 조회도 멈추지
    // 않는다 — 정확성의 기준은 언제나 무인덱스 경로다(REQ-041).
    if (subcommand === 'status') printOperation(queryIndex.indexStatus(options.root), options.json);
    else if (subcommand === 'clear') printOperation(queryIndex.clearIndex(options.root), options.json);
    else {
      const built = queryIndex.buildIndex(options.root);
      printOperation({ file: queryIndex.indexFile(built.builtFrom), fingerprint: built.fingerprint, documents: built.documents.length, tasks: built.tasks.length }, options.json);
    }
    return 0;
  }
  if (command === 'workset') {
    const subcommand = argv.shift();
    if (subcommand !== 'list') throw new Error('지원하는 작업 묶음 하위 명령은 list입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl workset list에는 위치 인수를 사용할 수 없습니다.');
    printOperation(require('../src/workset').listWorksets(options.root, { project: options.project, branch: options.branch }), options.json);
    return 0;
  }
  if (command === 'delegation') {
    const subcommand = argv.shift();
    if (!['list', 'grant', 'revoke'].includes(subcommand)) throw new Error('지원하는 위임 하위 명령은 list, grant, revoke입니다.');
    const options = parseOperationArgs(argv);
    const delegation = require('../src/delegation');
    if (subcommand === 'list') {
      if (options.positional.length) throw new Error('rdl delegation list에는 위치 인수를 사용할 수 없습니다.');
      printOperation(delegation.listDelegations(options.root, { project: options.project, active: options.active }), options.json);
      return 0;
    }
    if (subcommand === 'grant') {
      if (options.positional.length) throw new Error('rdl delegation grant에는 위치 인수를 사용할 수 없습니다.');
      printOperation(delegation.grantDelegation(options.root, {
        project: options.project, clientId: options.clientId, kind: options.kind,
        delegateClientId: options.delegate, grantedBy: options.member, reason: options.reason,
        days: options.days === undefined ? undefined : Number.parseInt(options.days, 10), rootRequestId: options.requestId
      }), options.json);
      return 0;
    }
    if (options.positional.length !== 1) throw new Error('rdl delegation revoke에는 DLG-ID 하나가 필요합니다.');
    printOperation(delegation.revokeDelegation(options.root, {
      project: options.project, clientId: options.clientId, delegationId: options.positional[0],
      revokedBy: options.member, reason: options.reason, rootRequestId: options.requestId
    }), options.json);
    return 0;
  }
  if (command === 'doctor') {
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl doctor에는 위치 인수를 사용할 수 없습니다.');
    const result = doctor(options.root, { gitUrl: options.gitUrl });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const item of result.checks) {
        const marker = { ok: 'OK', warn: 'WARN', error: 'ERROR', info: 'INFO' }[item.status] || item.status.toUpperCase();
        process.stdout.write(`[${marker}] ${item.id}: ${item.message}\n`);
        if (item.remediation) process.stdout.write(`       조치: ${item.remediation}\n`);
      }
      process.stdout.write(`\n오류 ${result.summary.errors} · 경고 ${result.summary.warnings} · 정상 ${result.summary.ok}\n`);
    }
    return result.summary.errors > 0 ? 1 : 0;
  }
  const { checkWorkspace } = require('../src/check');
  const { initState, refreshState, saveState, taskSet, taskAcceptance, taskCreate, syncState, migrateTaskStorage } = require('../src/state');
  const { startBoard } = require('../src/board');
  const { initObsidian } = require('../src/obsidian');
  const { installSkill } = require('../src/skill');
  const { initializeWorkspace, addProject } = require('../src/init');
  const { createDocument } = require('../src/document');
  const { discoverWorkspace } = require('../src/bootstrap');
  const { applyToProject, reconfigureProject, PROFILE_NAMES, ENFORCEMENTS, missingActions } = require('../src/document-profile');
  const { loadDocumentContract, planDocumentContract, updateDocumentContract } = require('../src/document-contract');
  const { migrateProject } = require('../src/document-migration');
  const { guidedProjectInput, selectProject: selectGuidedProject } = require('../src/guided');
  const { setupQuestions, resolveProfileDecision, remoteFacts, assertRemoteDecided } = require('../src/setup');
  const { readConflict, resolveConflict, clearConflict } = require('../src/conflict');
  const { recordTokens, debugSummary } = require('../src/debug');
  const { resolveAction, recordAction } = require('../src/action');
  const { migrateSettings, saveSettings } = require('../src/settings');
  const { attachWorkspace, repairWorkspace, detachWorkspace } = require('../src/attach');
  const { branchBoundaryStatus, installBranchBoundary } = require('../src/branch-boundary');
  const { auditStructure, cleanupStructure } = require('../src/structure');
  const { listClients, getClient, registerClient, setClientStatus, appendLease, listLeases } = require('../src/collaboration-store');
  if (command === 'init') {
    const options = parseOperationArgs(argv);
    if (options.positional.length > 1) throw new Error('rdl init에는 프로젝트 키를 하나만 지정할 수 있습니다.');
    if (options.guided && options.json) throw new Error('--guided와 --json은 함께 사용할 수 없습니다. 자동화에서는 --profile을 지정하세요.');
    // 대화형이 아닌 곳에서도 사람에게 물을 수 있어야 한다. 인터뷰를 흉내 내는
    // 대신 결정해야 할 것을 그대로 넘기고 답을 플래그로 받는다.
    if (options.questions) {
      printOperation(setupQuestions(options.root, { remote: options.remote }), options.json);
      return 0;
    }
    let selectedProject = options.project || options.positional[0] || null;
    const discovery = discoverWorkspace(options.root, { remote: options.remote, project: selectedProject });
    if (discovery.action === 'conflict') throw new Error(discovery.error || 'Rundol Workspace 상태가 충돌합니다.');
    if (discovery.action === 'needs-selection' && options.guided) {
      selectedProject = await selectGuidedProject(discovery.available);
      const selectedDiscovery = discoverWorkspace(options.root, { remote: options.remote, project: selectedProject });
      const connected = selectedDiscovery.action === 'repaired'
        ? repairWorkspace(options.root, { project: selectedProject, discovery: selectedDiscovery })
        : attachWorkspace(options.root, { project: selectedProject, remote: options.remote, discovery: selectedDiscovery });
      for (const item of connected.attached || []) initObsidian(connected.root, { project: item.project, force: false });
      printOperation(connected, options.json);
      return 0;
    }
    if (discovery.action === 'needs-selection' || discovery.action === 'already-connected') {
      const contractProject = selectedProject || (discovery.available && discovery.available.length === 1 ? discovery.available[0] : null);
      const result = contractProject && discovery.action === 'already-connected'
        ? Object.assign({}, discovery, { contract: loadDocumentContract(options.root, contractProject), boundary: installBranchBoundary(options.root, { remote: options.remote, project: contractProject }) })
        : discovery;
      printOperation(result, options.json);
      return 0;
    }
    if (discovery.action === 'repaired') {
      const repaired = repairWorkspace(options.root, { project: selectedProject, discovery });
      for (const item of repaired.attached || []) initObsidian(repaired.root, { project: item.project, force: false });
      repaired.contracts = (repaired.attached || []).map((item) => loadDocumentContract(repaired.root, item.project));
      printOperation(repaired, options.json);
      return 0;
    }
    if (discovery.action === 'attached') {
      const attached = attachWorkspace(options.root, { project: selectedProject, remote: options.remote, discovery });
      for (const item of attached.attached) initObsidian(attached.root, { project: item.project, force: false });
      attached.contracts = (attached.attached || []).map((item) => loadDocumentContract(attached.root, item.project));
      printOperation(attached, options.json);
      return 0;
    }
    // 대화형 터미널에서는 인터뷰가 기본이다. 설정을 그냥 넘어가는 것이 기본이면
    // 아무도 결정하지 않은 프로젝트가 만들어진다 — 생략이 예외여야 한다.
    if (!options.guided && !options.profile && !options.defaults && !options.json && process.stdin.isTTY && process.stdout.isTTY) options.guided = true;
    if (options.guided) {
      const guided = await guidedProjectInput({ key: options.positional[0], name: options.name, profile: options.profile, traits: options.traits });
      options.positional = [guided.key];
      options.name = guided.name;
      options.profile = guided.profile;
      options.traits = guided.traits;
    }
    if (!options.new && options.positional.length === 0) throw new Error('새 Workspace 생성에는 --new 또는 위치 프로젝트 키가 필요합니다.');
    if ((options.traits.length || options.policySpecified) && !options.profile) throw new Error('--trait 또는 policy override를 사용하려면 --profile이 필요합니다.');
    if (options.positional.length !== 1) throw new Error('rdl init에는 프로젝트 키 하나가 필요합니다.');
    // 문서 목표는 판단이고 기본 브랜치는 정보다. 판단은 선언하거나 기본값을
    // 명시적으로 수용해야 하고, 정보는 읽어서 기록하되 읽을 수 없으면 멈춘다 —
    // 아무도 결정하지 않은 값이 프로젝트의 기본이 되는 경로를 남기지 않는다.
    const decidedProfile = resolveProfileDecision({ profile: options.profile, defaults: options.defaults });
    const remoteDecision = assertRemoteDecided(remoteFacts(options.root, options.remote), options.primaryBranch);
    const initialized = initializeWorkspace(options.root, options.positional[0], options.name);
    const selectedProfile = decidedProfile.profile;
    const configuredProfile = applyToProject(path.join(initialized.projectRoot, 'project.md'), { schemaVersion: 2, name: selectedProfile, enforcement: options.enforcement || 'checkpoint', traits: options.traits, policy: options.policySpecified ? options.policy : undefined }).profile;
    const git = initState(initialized.root, { project: initialized.project });
    initObsidian(initialized.root, { project: initialized.project, force: false });
    const contract = loadDocumentContract(initialized.root, initialized.project);
    printOperation(Object.assign({ action: 'created', profile: selectedProfile, profileSource: decidedProfile.source, remote: remoteDecision, traits: configuredProfile.traits, missing: missingActions(configuredProfile, []), contract }, initialized, { branch: git.branch, worktree: git.worktree, boundary: git.boundary }), options.json);
    return 0;
  }
  if (command === 'attach' || command === 'detach') {
    const options = parseOperationArgs(argv);
    if (options.positional.length > 1) throw new Error(`rdl ${command}에는 프로젝트 키를 하나만 지정할 수 있습니다.`);
    const project = options.positional[0] || options.project;
    const result = command === 'attach'
      ? attachWorkspace(options.root, { project, remote: options.remote })
      : detachWorkspace(options.root, { project, remote: options.remote });
    if (command === 'attach') {
      for (const item of result.attached || []) initObsidian(result.root, { project: item.project, force: false });
      result.contracts = (result.attached || []).map((item) => loadDocumentContract(result.root, item.project));
    }
    printOperation(result, options.json);
    return 0;
  }
  if (command === 'project') {
    const subcommand = argv.shift();
    if (subcommand === 'profile') {
      const profileOptions = parseOperationArgs(argv);
      if (profileOptions.positional.length) throw new Error('rdl project profile은 위치 인수를 사용하지 않습니다.');
      // contract set과 같은 목록을 봐야 한다. 한쪽만 팀 프리셋을 받으면 같은 이름이
      // 명령에 따라 되기도 하고 안 되기도 한다.
      const { workspaceLayout, selectProject } = require('../src/workspace');
      const layout = workspaceLayout(profileOptions.root);
      const { loadBoardPresentation, resolveProfilePresets } = require('../src/board-presentation');
      const presets = resolveProfilePresets(loadBoardPresentation(layout.root, profileOptions.project));
      if (!Object.keys(presets).includes(profileOptions.profile)) throw new Error(`--profile <${Object.keys(presets).join('|')}>가 필요합니다.`);
      const selected = selectProject(layout, profileOptions.project, true);
      const updated = reconfigureProject(selected.charter, profileOptions.profile, {
        enforcement: profileOptions.enforcement,
        traits: profileOptions.traits.length ? profileOptions.traits : undefined,
        policy: profileOptions.policySpecified ? profileOptions.policy : undefined
      }, presets);
      const registry = require('../src/document').registry(selected);
      const present = Array.from(registry.keys()).map((id) => /^([A-Z]{3})-/u.exec(id)).filter(Boolean).map((match) => match[1]);
      printOperation({ root: layout.root, project: selected.key, profile: updated.profile.name, enforcement: updated.profile.enforcement, traits: updated.profile.traits, revision: updated.profile.revision, history: updated.profile.history, legacyUnconfigured: updated.legacyUnconfigured, migratedFrom: updated.migratedFrom, impact: updated.impact, file: updated.file, missing: missingActions(updated.profile, present), contract: loadDocumentContract(layout.root, selected.key) }, profileOptions.json);
      return 0;
    }
    if (subcommand !== 'add') throw new Error('지원하는 project 하위 명령은 add와 profile입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length !== 1) throw new Error('rdl project add에는 프로젝트 키 하나가 필요합니다.');
    const added = addProject(options.root, options.positional[0], options.name);
    if (!options.profile) options.profile = 'service';
    if (options.profile) {
      if (!PROFILE_NAMES.includes(options.profile)) throw new Error(`지원하지 않는 문서 프로필입니다: ${options.profile}`);
      applyToProject(path.join(added.projectRoot, 'project.md'), { schemaVersion: 2, name: options.profile, enforcement: options.enforcement || 'checkpoint' });
    }
    const git = initState(options.root, { project: added.project });
    initObsidian(options.root, { project: added.project, force: false });
    const settings = saveSettings(options.root);
    printOperation(Object.assign({}, added, { branch: git.branch, commit: git.commit, settings, boundary: git.boundary, contract: loadDocumentContract(options.root, added.project) }), options.json);
    return 0;
  }
  if (command === 'contract') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl contract 명령은 위치 인수를 사용하지 않습니다.');
    if (['show', 'next', 'check', 'trace'].includes(subcommand)) {
      const contract = loadDocumentContract(options.root, options.project);
      const result = subcommand === 'next' ? Object.assign({ root: contract.root, project: contract.project, status: contract.status }, contract.evaluation || {}) : subcommand === 'trace' ? Object.assign({ root: contract.root, project: contract.project }, contract.traceability) : contract;
      printOperation(result, options.json);
      if (subcommand === 'check' && (contract.status === 'invalid' || contract.status === 'unsupported-schema' || (contract.enforcement === 'checkpoint' && contract.evaluation && contract.evaluation.violations.some((item) => item.code !== 'recommended-missing')))) return 1;
      return 0;
    }
    if (subcommand === 'diagram') {
      const { workspaceLayout, selectProject } = require('../src/workspace');
      const { projectArtifacts } = require('../src/document-contract');
      const { runGit } = require('../src/git');
      const { prepareCompositeDocuments, compositeViewState, writeCompositeViews, sourceRevision } = require('../src/document-composite');
      const layout = workspaceLayout(options.root);
      const project = selectProject(layout, options.project);
      const documents = prepareCompositeDocuments(projectArtifacts(project));
      const { revision, dirty } = sourceRevision(runGit, project.root);
      const result = options.write
        ? Object.assign({ root: layout.root, project: project.key, revision, dirty }, writeCompositeViews(project.root, documents, revision))
        : { root: layout.root, project: project.key, revision, dirty, directory: null, views: compositeViewState(project.root, documents, revision) };
      printOperation(Object.assign({ action: options.write ? 'written' : 'computed' }, result), options.json);
      return 0;
    }
    // 예전 계약에 남은 값을 새 자리로 옮긴다. 계획을 먼저 보여주고 --write일 때만 쓴다.
    if (subcommand === 'migrate') {
      const { planContractMigration, applyContractMigration } = require('../src/document-contract');
      const result = options.write ? applyContractMigration(options.root, options.project) : planContractMigration(options.root, options.project);
      printOperation(Object.assign({ action: options.write ? 'migrated' : 'planned' }, result), options.json);
      return 0;
    }
    if (!['plan', 'set'].includes(subcommand)) throw new Error('지원하는 contract 하위 명령은 show, next, check, trace, plan, set, migrate, diagram입니다.');
    // 고를 수 있는 프로필은 내장 다섯 개가 아니라 board.json 상속이 정한 목록이다.
    // 팀이 만든 프리셋을 CLI가 거절하면 화면에서만 쓸 수 있는 반쪽 기능이 된다.
    {
      const { loadBoardPresentation, resolveProfilePresets } = require('../src/board-presentation');
      const { workspaceLayout } = require('../src/workspace');
      const available = Object.keys(resolveProfilePresets(loadBoardPresentation(workspaceLayout(options.root).root, options.project)));
      if (!available.includes(options.profile)) throw new Error(`--profile <${available.join('|')}>가 필요합니다.`);
    }
    if (options.enforcement && !ENFORCEMENTS.includes(options.enforcement)) throw new Error('--enforcement는 advisory 또는 checkpoint여야 합니다.');
    const input = { name: options.profile };
    if (options.enforcement) input.enforcement = options.enforcement;
    if (options.traits.length) input.traits = options.traits;
    if (options.policySpecified) input.policy = options.policy;
    if (subcommand === 'set') input.baseRevision = loadDocumentContract(options.root, options.project).revision;
    const result = subcommand === 'plan' ? planDocumentContract(options.root, options.project, input) : updateDocumentContract(options.root, options.project, input);
    printOperation(result, options.json);
    return 0;
  }
  if (command === 'check') {
    if (argv.includes('--structure')) {
      const filtered = argv.filter((value) => value !== '--structure');
      const options = parseOperationArgs(filtered);
      printOperation(auditStructure(options.root, options), options.json);
      return 0;
    }
    const options = parseArgs(argv);
    const result = checkWorkspace(options.root, options);
    result.diagnostics = filterDiagnostics(result.diagnostics, options);
    result.summary.errors = result.diagnostics.filter((item) => item.severity === 'error').length;
    result.summary.warnings = result.diagnostics.filter((item) => item.severity === 'warning').length;
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printText(result);
    return result.summary.errors > 0 ? 1 : 0;
  }
  if (command === 'cleanup') {
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl cleanup에는 위치 인수를 사용할 수 없습니다.');
    printOperation(cleanupStructure(options.root, options), options.json);
    return 0;
  }
  if (command === 'git') {
    const subcommand = argv.shift();
    if (!['init', 'boundary'].includes(subcommand)) throw new Error('지원하는 Git 하위 명령은 rdl git init, rdl git boundary입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length > 0) throw new Error(`rdl git ${subcommand}에 위치 인수를 사용할 수 없습니다.`);
    const result = subcommand === 'init' ? initState(options.root, options) : branchBoundaryStatus(options.root, options);
    printOperation(result, options.json);
    return subcommand === 'boundary' && !result.valid ? 1 : 0;
  }
  if (command === 'refresh') {
    const options = parseOperationArgs(argv);
    if (options.positional.length > 0) throw new Error('rdl refresh에 위치 인수를 사용할 수 없습니다.');
    printOperation(refreshState(options.root, options), options.json);
    return 0;
  }
  if (command === 'obsidian') {
    const subcommand = argv.shift();
    if (subcommand !== 'init') throw new Error('지원하는 Obsidian 하위 명령은 rdl obsidian init입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length > 0) throw new Error('rdl obsidian init에 위치 인수를 사용할 수 없습니다.');
    printOperation(initObsidian(options.root, options), options.json);
    return 0;
  }
  if (command === 'skill') {
    const subcommand = argv.shift();
    if (subcommand !== 'install') throw new Error('지원하는 스킬 하위 명령은 rdl skill install입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length > 0) throw new Error('rdl skill install에 위치 인수를 사용할 수 없습니다.');
    const result = installSkill({ force: options.force });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const item of result.targets) {
        if (item.status === 'preserved') process.stdout.write(`preserved: ${item.client} ${item.target}\n`);
        else process.stdout.write(`installed: ${item.client} ${item.target}\n`);
      }
    }
    return 0;
  }
  if (command === 'save') {
    const options = parseOperationArgs(argv);
    if (options.positional.length > 0) throw new Error('rdl save는 위치 인수를 사용하지 않습니다.');
    printOperation(saveState(options.root, options), options.json);
    return 0;
  }
  if (command === 'watch') {
    const options = parseWatchArgs(argv);
    const write = (records) => {
      for (const record of Array.isArray(records) ? records : [records]) {
        const line = typeof record === 'string' ? record.replace(/\r?\n$/u, '') : JSON.stringify(record);
        process.stdout.write(`${line}\n`);
      }
    };
    const result = await require('../src/watch').runWatch(options.root, {
      project: options.project, remote: options.remote, once: options.once, json: options.json, write
    });
    return result && Number.isInteger(result.exitCode) ? result.exitCode : 0;
  }
  if (command === 'sync') {
    const subcommand = argv[0] === 'watch' ? argv.shift() : null;
    const options = parseOperationArgs(argv);
    if (options.positional.length > 0) throw new Error('rdl sync에 위치 인수를 사용할 수 없습니다.');
    if (subcommand === 'watch') {
      const interval = Number.parseInt(options.interval || '60', 10);
      if (!Number.isInteger(interval) || interval < 5) throw new Error('--interval은 5초 이상의 정수여야 합니다.');
      do {
        printOperation(Object.assign({ syncedAt: new Date().toISOString() }, syncState(options.root, options)), options.json);
        if (options.once) break;
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      } while (true);
      return 0;
    }
    printOperation(syncState(options.root, options), options.json);
    return 0;
  }
  if (command === 'settings') {
    const subcommand = argv.shift();
    if (subcommand !== 'migrate') throw new Error('지원하는 settings 하위 명령은 rdl settings migrate입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl settings migrate에는 위치 인수를 사용할 수 없습니다.');
    printOperation(migrateSettings(options.root), options.json);
    return 0;
  }
  if (command === 'workspace') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl workspace 명령에는 위치 인수를 사용할 수 없습니다.');
    const { workspaceLayout } = require('../src/workspace');
    const { syncSettings } = require('../src/settings');
    if (subcommand === 'show') {
      const layout = workspaceLayout(options.root);
      printOperation({ root: layout.root, schemaVersion: layout.schemaVersion, branch: layout.schemaVersion >= 6 ? 'rundol/workspace' : 'rundol/settings', projects: layout.projects.map((project) => project.key) }, options.json);
    } else if (subcommand === 'check') {
      const layout = workspaceLayout(options.root);
      const clients = layout.schemaVersion >= 6 ? listClients(options.root).clients.length : 0;
      printOperation({ root: layout.root, valid: true, schemaVersion: layout.schemaVersion, projects: layout.projects.length, clients }, options.json);
    } else if (subcommand === 'sync') printOperation(syncSettings(options.root, options), options.json);
    else if (subcommand === 'migrate') printOperation(migrateSettings(options.root), options.json);
    else throw new Error('지원하는 workspace 하위 명령은 show, check, sync, migrate입니다.');
    return 0;
  }
  if (command === 'member') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    const { readCollaboration, addMember, updateCollaboration } = require('../src/collaboration');
    if (subcommand === 'list') printOperation(Object.assign({}, readCollaboration(options.root, options.project), { roles: undefined, stakeholders: undefined }), options.json);
    else if (subcommand === 'add') {
      if (options.positional.length > 1) throw new Error('rdl member add는 이름 하나만 위치 인수로 받습니다.');
      printOperation(addMember(options.root, {
        name: options.positional[0] || options.name,
        member: options.member,
        organization: options.organization,
        account: options.account,
        responsibility: options.responsibility,
        roles: options.roles
      }, options.project), options.json);
    } else if (subcommand === 'set') {
      if (options.positional.length !== 1) throw new Error('rdl member set에는 MEMBER-ID 또는 STAKEHOLDER-ID 하나가 필요합니다.');
      const fields = {};
      // 역할 필드 이름이 대상마다 다르다. member는 역할, stakeholder는 담당 역할이라
      // 한쪽 이름으로만 보내면 다른 쪽에서는 조용히 무시된다.
      if (options.roles.length) fields[options.positional[0].startsWith('STAKEHOLDER-') ? '담당 역할' : '역할'] = options.roles.join(', ');
      if (options.organization !== null) fields['소속'] = options.organization;
      if (options.account !== null) fields['업무 계정'] = options.account;
      if (options.responsibility !== null) fields['책임 영역'] = options.responsibility;
      if (options.status !== undefined) fields['상태'] = options.status;
      printOperation(updateCollaboration(options.root, options.positional[0], { name: options.name, fields }, options.project), options.json);
    } else throw new Error('지원하는 member 하위 명령은 add, set, list입니다.');
    return 0;
  }

  if (command === 'client') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    if (subcommand === 'list') printOperation(listClients(options.root), options.json);
    else {
      if (options.positional.length !== 1) throw new Error(`rdl client ${subcommand}에는 Client ID 하나가 필요합니다.`);
      const id = options.positional[0];
      if (subcommand === 'register') printOperation(registerClient(options.root, { id, name: options.name, type: options.type, owner: options.owner }), options.json);
      else if (subcommand === 'show') printOperation(getClient(options.root, id), options.json);
      else if (subcommand === 'enable') printOperation(setClientStatus(options.root, id, 'active'), options.json);
      else if (subcommand === 'disable') printOperation(setClientStatus(options.root, id, 'disabled'), options.json);
      else throw new Error('지원하는 client 하위 명령은 register, list, show, enable, disable입니다.');
    }
    return 0;
  }
  if (command === 'lease') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    if (subcommand === 'list') {
      if (options.positional.length) throw new Error('rdl lease list에는 위치 인수를 사용할 수 없습니다.');
      printOperation(listLeases(options.root, options.project), options.json);
    } else {
      if (!['acquire', 'renew', 'release'].includes(subcommand)) throw new Error('지원하는 lease 하위 명령은 acquire, renew, release, list입니다.');
      if (options.positional.length !== 1) throw new Error(`rdl lease ${subcommand}에는 DOCUMENT-ID 하나가 필요합니다.`);
      if (!options.clientId) throw new Error('--client-id <id>가 필요합니다.');
      printOperation(appendLease(options.root, subcommand, { project: options.project, clientId: options.clientId, documentId: options.positional[0] }), options.json);
    }
    return 0;
  }
  if (command === 'adapter') {
    const subcommand = argv.shift();
    if (subcommand !== 'run') throw new Error('지원하는 adapter 하위 명령은 run입니다.');
    const options = parseOperationArgs(argv);
    if (options.positional.length !== 1) throw new Error('rdl adapter run <name> 형식이 필요합니다.');
    if (!options.project || !options.run || !options.step || !options.mode || !options.clientId) {
      throw new Error('rdl adapter run에는 --project, --run, --step, --mode, --client-id가 필요합니다.');
    }
    if (!['author', 'verify'].includes(options.mode)) throw new Error('--mode는 author 또는 verify여야 합니다.');
    if (options.requestId) throw new Error('rdl adapter run은 canonical event를 기록하지 않으므로 --request-id를 사용하지 않습니다.');
    const result = await require('../src/adapter').runAdapterCommand(options.root, Object.assign({}, options, { adapter: options.positional[0] }));
    printOperation(result, options.json);
    return result.exitCode === 0 ? 0 : (result.exitCode === 1 ? 1 : 2);
  }
  if (command === 'verify') {
    const options = parseOperationArgs(argv);
    if (options.positional.length !== 1) throw new Error('rdl verify <ARTIFACT-ID> 형식이 필요합니다.');
    if (!options.project || !options.clientId) throw new Error('rdl verify에는 --project와 --client-id가 필요합니다.');
    const rootRequestId = options.requestId || require('../src/run-ledger').newRequestId();
    let result;
    try {
      result = await require('../src/verify').verifyArtifact(options.root, {
        project: options.project,
        targetId: options.positional[0],
        clientId: options.clientId,
        adapter: options.adapter,
        lenses: options.lenses.length ? options.lenses : undefined,
        runId: options.run,
        rootRequestId
      });
    } catch (error) {
      if (!options.run || error.code !== 'adapter-failed') throw error;
      result = {
        exitCode: 2,
        status: /timeout/u.test(String(error.message || '')) ? 'adapter-timeout' : 'invalid-output',
        targetId: options.positional[0],
        rootRequestId,
        errorCode: error.code
      };
    }
    const integrated = options.run
      ? require('../src/run').recordVerificationResult(options.root, options, result)
      : result;
    printOperation(integrated, options.json);
    return result.exitCode === 0 ? 0 : (result.exitCode === 1 ? 1 : 2);
  }
  if (command === 'run') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    const run = require('../src/run');
    const requireRun = () => { if (!options.run) throw new Error('--run <RUN-ID>가 필요합니다.'); return options; };
    if (subcommand === 'start') printOperation(run.startRun(options.root, options), options.json);
    else if (subcommand === 'next') printOperation(run.nextStep(options.root, requireRun()), options.json);
    else if (subcommand === 'step') printOperation(run.reportStep(options.root, requireRun()), options.json);
    else if (subcommand === 'gate') {
      const result = run.runGate(options.root, requireRun());
      printOperation(result, options.json);
      return result.exitCode === 0 ? 0 : (result.exitCode === 1 ? 1 : 2);
    } else if (subcommand === 'halt') printOperation(run.haltRun(options.root, requireRun()), options.json);
    else if (subcommand === 'resume') printOperation(run.resumeRun(options.root, requireRun()), options.json);
    else if (subcommand === 'complete') printOperation(run.completeRun(options.root, requireRun()), options.json);
    else if (subcommand === 'takeover') {
      requireRun();
      printOperation(run.takeoverRunCommand(options.root, options), options.json);
    } else if (subcommand === 'ownership') {
      requireRun();
      if (options.positional.length !== 1 || options.positional[0] !== 'resolve') throw new Error('rdl run ownership은 resolve 하위 명령이 필요합니다.');
      printOperation(run.resolveOwnershipCommand(options.root, options), options.json);
    } else if (subcommand === 'drive') {
      requireRun();
      if (options.positional.length) throw new Error('rdl run drive does not accept positional arguments');
      if (!options.project || !options.clientId) throw new Error('rdl run drive requires --run, --project, and --client-id');
      let result;
      try {
        result = await run.runDrive(options.root, options);
      } catch (error) {
        result = { exitCode: 2, status: 'rejected', canonicalCommitted: false, reason: error.message };
      }
      if (result.exitCode === 2 && result.canonicalCommitted === undefined) result.canonicalCommitted = false;
      printOperation(result, options.json);
      return result.exitCode === 0 ? 0 : (result.exitCode === 1 ? 1 : 2);
    } else if (subcommand === 'operation') {
      requireRun();
      if (options.positional.length !== 1 || options.positional[0] !== 'resolve') throw new Error('rdl run operation requires the resolve subcommand');
      if (!options.project || !options.operation || !options.conflict || !options.select || !options.clientId || !options.reason) {
        throw new Error('rdl run operation resolve requires --run, --project, --operation, --conflict, --select, --client-id, and --reason');
      }
      if (options.scheduled) throw new Error('--scheduled is valid only for rdl run drive');
      let result;
      try {
        result = await run.resolveOperation(options.root, options);
      } catch (error) {
        result = { exitCode: 2, status: 'rejected', canonicalCommitted: false, reason: error.message };
      }
      printOperation(result, options.json);
      return result.exitCode === 0 ? 0 : (result.exitCode === 1 ? 1 : 2);
    } else if (subcommand === 'requests') {
      if (options.positional.length) throw new Error('rdl run requests는 위치 인수를 사용하지 않습니다.');
      printOperation(run.listRunRequests(options.root, options), options.json);
    } else if (subcommand === 'request') {
      if (options.positional.length !== 2 || options.positional[0] !== 'resume') throw new Error('rdl run request resume <REQ-ID> 형식이 필요합니다.');
      printOperation(await run.resumeRunRequest(options.root, options), options.json);
    } else if (subcommand === 'list') printOperation(run.listRunsCommand(options.root, options), options.json);
    else if (subcommand === 'log') printOperation(run.runLog(options.root, requireRun()), options.json);
    else if (subcommand === 'procedures') printOperation(run.listProceduresCommand(options.root, options), options.json);
    else throw new Error('지원하는 run 하위 명령은 start, next, step, gate, halt, resume, complete, takeover, ownership resolve, requests, request resume, list, log, procedures입니다.');
    return 0;
  }
  if (command === 'task') {
    const subcommand = argv.shift();
    if (!['add', 'set', 'list', 'acceptance', 'migrate'].includes(subcommand)) throw new Error('지원하는 태스크 하위 명령은 add, set, list, acceptance, migrate입니다.');
    const options = parseOperationArgs(argv);
    if (subcommand === 'list') {
      if (options.positional.length) throw new Error('rdl task list에는 위치 인수를 사용할 수 없습니다.');
      const listed = require('../src/agent-context').listTasks(options.root, { project: options.project, status: options.status, open: options.open });
      printOperation(listed, options.json);
      return 0;
    }
    if (subcommand === 'migrate') {
      if (options.positional.length) throw new Error('rdl task migrate에는 위치 인수를 사용할 수 없습니다.');
      const maxItems = Number.parseInt(options.maxItems || '500', 10);
      if (!Number.isInteger(maxItems) || maxItems < 10 || maxItems > 2000) throw new Error('--max-items는 10~2000 사이 정수여야 합니다.');
      printOperation(migrateTaskStorage(options.root, { project: options.project, clientId: options.clientId, maxItems }), options.json);
      return 0;
    }
    if (subcommand === 'add') {
      const title = options.positional.join(' ').trim();
      if (!title) throw new Error('rdl task add에는 태스크 제목이 필요합니다.');
      if (options.acceptance.length === 0) throw new Error('rdl task add에는 --acceptance 완료조건이 하나 이상 필요합니다.');
      if (!['high', 'mid', 'low'].includes(options.priority)) throw new Error(`지원하지 않는 우선순위입니다: ${options.priority}`);
      const acceptanceCriteria = {};
      options.acceptance.forEach((text, index) => {
        acceptanceCriteria[`AC-${String(index + 1).padStart(3, '0')}`] = { text, done: false };
      });
      const result = taskCreate(options.root, {
        project: options.project,
        title,
        summary: options.summary,
        owner: options.owner === undefined ? null : options.owner,
        reviewers: options.reviewers,
        stakeholders: options.stakeholders,
        status: 'todo',
        priority: options.priority,
        links: options.links,
        deps: [],
        acceptanceCriteria,
        blocker: null,
        externalRefs: []
      });
      printOperation(result, options.json);
      if (DEBUG_CONTEXT) recordAction(options.root, { action: 'task.create', actualExecutor: 'cli', taskId: result.taskId });
      return 0;
    }
    if (subcommand === 'acceptance') {
      if (options.positional.length !== 2) throw new Error('rdl task acceptance에는 TASK-ID와 AC-ID가 필요합니다.');
      if (options.done === options.undone) throw new Error('--done 또는 --undone 중 하나가 필요합니다.');
      const result = taskAcceptance(options.root, options.positional[0], options.positional[1], options.done, options.project);
      printOperation(result, options.json);
      if (DEBUG_CONTEXT) recordAction(options.root, { action: 'task.acceptance', actualExecutor: 'cli', taskId: options.positional[0] });
      return 0;
    }
    if (options.positional.length !== 1) throw new Error('rdl task set에는 TASK-ID 하나가 필요합니다.');
    const changes = {};
    if (options.status !== undefined) changes.status = options.status;
    if (options.owner !== undefined) changes.owner = options.owner;
    // 브랜치·병합 요청 참조는 태스크의 새 필드가 아니라 externalRefs 항목이다.
    // 같은 브랜치를 공유하는 태스크들이 곧 작업 묶음이므로, 참조를 붙이는 것이
    // 묶음을 만드는 일이고 review 전이(RDL-TASK-020)가 도달 가능해진다.
    if (options.externalRefs.length) {
      const { normalizeExternalRef, assertBranchName } = require('../src/workset');
      const { readTaskStore } = require('../src/tasks');
      const { stateConfig } = require('../src/state');
      const config = stateConfig(options.root, options.project);
      const current = readTaskStore(path.join(config.worktree, config.taskRelative)).tasks[options.positional[0]];
      if (!current) throw new Error(`태스크를 찾지 못했습니다: ${options.positional[0]}`);
      const existing = (current.externalRefs || []).map(normalizeExternalRef);
      const added = options.externalRefs.map((entry) => {
        const separator = String(entry).indexOf('=');
        if (separator < 1) throw new Error(`--external-ref는 <종류>=<값> 형식이어야 합니다: ${entry}`);
        const reference = normalizeExternalRef(entry);
        if (reference.kind === 'branch') assertBranchName(reference.value);
        return reference;
      });
      const merged = existing.filter((reference) => !added.some((entry) => entry.kind === reference.kind)).concat(added);
      changes.externalRefs = merged;
    }
    // 반려는 결정이므로 사유를 함께 받는다. 결정자를 생략하면 taskSet이 태스크 owner로 채운다.
    if (options.status === 'cancelled') {
      if (!options.reason) throw new Error('반려하려면 --reason이 필요합니다.');
      changes.cancellation = { reason: options.reason, decidedBy: options.decidedBy || options.owner || null, at: new Date().toISOString() };
    }
    else if (options.reason) throw new Error('--reason은 --status cancelled에만 사용합니다.');
    if (Object.keys(changes).length === 0) throw new Error('--status, --owner 또는 --external-ref 중 하나가 필요합니다.');
    const result = taskSet(options.root, options.positional[0], changes, options.project);
    printOperation(result, options.json);
    if (DEBUG_CONTEXT) recordAction(options.root, { action: 'task.update', actualExecutor: 'cli', taskId: options.positional[0] });
    return 0;
  }
  if (command === 'doc') {
    const subcommand = argv.shift();
    // 승인은 초안과 정본의 경계다. 신뢰 상태는 파일이 아니라 원장에서 파생하므로
    // frontmatter의 state를 무엇으로 적든 이 결과는 바뀌지 않는다.
    // 소급 부여는 문서 내용을 바꿔 리비전이 변하고, 그러면 기존 승인이 낡는다.
    // 그래서 --apply 없이는 무엇이 바뀔지만 보여준다.
    if (subcommand === 'identity') {
      const identityOptions = parseOperationArgs(argv);
      if (identityOptions.positional.length) throw new Error('rdl doc identity는 위치 인수를 사용하지 않습니다.');
      printOperation(require('../src/document-identity').migrateDocumentUids(identityOptions.root, { project: identityOptions.project, apply: identityOptions.apply }), identityOptions.json);
      return 0;
    }
    if (['status', 'approve', 'history', 'diff'].includes(subcommand)) {
      const options = parseOperationArgs(argv);
      const approval = require('../src/approval');
      if (subcommand === 'status') {
        if (options.positional.length) throw new Error('rdl doc status에는 위치 인수를 사용할 수 없습니다.');
        printOperation(approval.documentStatus(options.root, { project: options.project, status: options.status }), options.json);
        return 0;
      }
      if (options.positional.length !== 1) throw new Error(`rdl doc ${subcommand}에는 ARTIFACT-ID 하나가 필요합니다.`);
      if (subcommand === 'history') {
        printOperation(approval.documentHistory(options.root, { project: options.project, targetId: options.positional[0] }), options.json);
        return 0;
      }
      if (subcommand === 'diff') {
        if (!options.sinceApproval) throw new Error('rdl doc diff에는 --since-approval이 필요합니다.');
        printOperation(approval.diffSinceApproval(options.root, { project: options.project, targetId: options.positional[0] }), options.json);
        return 0;
      }
      // 근거는 무엇에 기대어 승인했는지다. 사유 문장은 선택이지만 근거는 필수다 —
      // 나중에 "AI 검토가 놓쳤나 사람이 건너뛰었나"를 구분하려면 그것이 필요하다.
      const basis = options.basis.map((entry) => {
        const separator = String(entry).indexOf('=');
        return separator < 1 ? { kind: entry } : { kind: entry.slice(0, separator), detail: entry.slice(separator + 1) };
      });
      printOperation(approval.approveDocument(options.root, {
        project: options.project, clientId: options.clientId, targetId: options.positional[0],
        approvedBy: options.member, basis, reason: options.reason, delegationId: options.delegation, rootRequestId: options.requestId
      }), options.json);
      return 0;
    }
    if (subcommand === 'migrate') {
      const migrationOptions = parseOperationArgs(argv);
      if (migrationOptions.positional.length) throw new Error('rdl doc migrate는 위치 인수를 사용하지 않습니다.');
      const { workspaceLayout, selectProject } = require('../src/workspace');
      const layout = workspaceLayout(migrationOptions.root);
      const selected = selectProject(layout, migrationOptions.project, true);
      const migrated = migrateProject(selected.root, {
        apply: migrationOptions.apply,
        validate: () => {
          const checked = checkWorkspace(layout.root, { project: selected.key, strict: true, skipProfilePolicy: true });
          const structure = auditStructure(layout.root, { project: selected.key });
          return Object.assign({}, checked, {
            diagnostics: checked.diagnostics.concat(structure.candidates.filter((item) => item.kind === 'legacy-document-migration').map((item) => ({
              severity: 'error', code: 'RDL-STRUCTURE-MIGRATION', file: item.file, message: item.reason
            })))
          });
        }
      });
      printOperation(Object.assign({ project: selected.key }, migrated), migrationOptions.json);
      return 0;
    }
    if (subcommand !== 'create') throw new Error('지원하는 문서 하위 명령은 create와 migrate입니다.');
    const options = parseOperationArgs(argv);
    const type = options.positional.shift();
    const title = options.positional.join(' ').trim();
    const result = createDocument(options.root, { type, title, project: options.project, owner: options.owner, related: options.related, domain: options.domain, feature: options.feature, scope: options.scope, excludes: options.excludes, functionIds: options.functionIds });
    printOperation(result, options.json);
    if (DEBUG_CONTEXT) recordAction(options.root, { action: 'document.create', actualExecutor: 'cli', artifactId: result.id });
    return 0;
  }
  if (command === 'action') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    if (options.positional.length !== 1) throw new Error('rdl action 명령에는 표준 ACTION 하나가 필요합니다.');
    if (subcommand === 'resolve') printOperation(resolveAction(options.positional[0]), options.json);
    else if (subcommand === 'record') printOperation(recordAction(options.root, Object.assign({}, options, { action: options.positional[0] })), options.json);
    else throw new Error('지원하는 action 하위 명령은 resolve와 record입니다.');
    return 0;
  }
  if (command === 'conflict') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl conflict 명령에는 위치 인수를 사용할 수 없습니다.');
    if (subcommand === 'list') printOperation(readConflict(options.root, options.project), options.json);
    else if (subcommand === 'resolve') printOperation(resolveConflict(options.root, { project: options.project, strategy: options.strategy }), options.json);
    else if (subcommand === 'clear') printOperation(clearConflict(options.root, options.project), options.json);
    else throw new Error('지원하는 conflict 하위 명령은 list, resolve, clear입니다.');
    return 0;
  }
  if (command === 'debug') {
    const subcommand = argv.shift();
    const options = parseOperationArgs(argv);
    if (options.positional.length) throw new Error('rdl debug 명령에는 위치 인수를 사용할 수 없습니다.');
    if (subcommand === 'record') printOperation(recordTokens(options.root, options), options.json);
    else if (subcommand === 'summary') printOperation(debugSummary(options.root, options.project), options.json);
    else throw new Error('지원하는 debug 하위 명령은 record와 summary입니다.');
    return 0;
  }
  if (command === 'board') {
    const options = parseBoardArgs(argv);
    const board = await startBoard(options.root, options);
    const result = { root: board.root, url: board.url, port: board.port, opened: options.open };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`Rundol board: ${board.url}\n`);
      process.stdout.write('종료하려면 Ctrl+C를 누르세요.\n');
    }
    return 0;
  }
  throw new Error(`지원하지 않는 명령: ${command}`);
}

main().then((code) => {
  if (DEBUG_CONTEXT) {
    try { require('../src/debug').appendDebug(DEBUG_CONTEXT.root, { type: 'command', project: DEBUG_CONTEXT.project, command: DEBUG_CONTEXT.command, status: code === 0 ? 'success' : 'failed', exitCode: code, durationMs: Date.now() - CLI_STARTED_AT }); } catch (_) {}
  }
  process.exitCode = code;
}).catch((error) => {
  if (DEBUG_CONTEXT) {
    try { require('../src/debug').appendDebug(DEBUG_CONTEXT.root, { type: 'command', project: DEBUG_CONTEXT.project, command: DEBUG_CONTEXT.command, status: 'error', error: error.message, durationMs: Date.now() - CLI_STARTED_AT }); } catch (_) {}
  }
  process.stderr.write(`rdl: ${error.message}\n`);
  process.exitCode = 2;
});
