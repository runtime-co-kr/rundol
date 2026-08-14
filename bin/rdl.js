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
  rdl init [project-key] [--name <project-name>] [--project <key>] [--remote <name>] [--new] [--guided] [--profile <name>] [--trait <name>] [--root <path>] [--json]
  rdl attach [project-key] [--remote <name>] [--root <path>] [--json]
  rdl detach <project-key> [--remote <name>] [--root <path>] [--json]
  rdl project add <project-key> --name <project-name> [--profile <name>] [--root <path>] [--json]
  rdl project profile --project <key> --profile <lean|product|service|platform|assured> [--trait <name>] [--required <TYPE,...>] [--recommended <TYPE,...>] [--on-demand <TYPE,...>] [--disabled <TYPE,...>] [--json]
  rdl contract show|next|check|trace --project <key> [--json]
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
  rdl client register <client-id> --name <name> --type <device|agent|service> --owner <MEMBER-ID> [--json]
  rdl client list|show <client-id>|enable <client-id>|disable <client-id> [--json]
  rdl lease acquire|renew|release <DOCUMENT-ID> --project <key> --client-id <id> [--json]
  rdl lease list --project <key> [--json]
  rdl task add <제목> --acceptance <완료조건> [--summary <설명>] [--owner <MEMBER-ID>]
                   [--reviewer <MEMBER-ID>] [--stakeholder <STAKEHOLDER-ID>]
                   [--priority <high|mid|low>] [--link <ARTIFACT-ID>] [--json]
  rdl task set <TASK-ID> [--project <key>] [--status <state>] [--owner <MEMBER-ID|null>] [--json]
  rdl task acceptance <TASK-ID> <AC-ID> (--done|--undone) [--project <key>] [--json]
  rdl task migrate [--project <key>] [--client-id <id>] [--max-items <n>] [--json]
  rdl doc create <TYPE> <제목> --owner <MEMBER-ID> --scope <단일-책임> --exclude <제외-범위>
                 [--function-id <기능-ID>] [--exclude <제외-범위>] [--related <ARTIFACT-ID>] [--project <key>] [--json]
  rdl doc migrate [--project <key>] [--apply] [--json]
  rdl sync [--root <path>] [--project <key>] [--remote <name>] [--no-push] [--json]
  rdl sync watch [--interval <seconds>] [--project <key>] [--no-push] [--once] [--json]
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

function parseOperationArgs(argv) {
  const options = { root: process.cwd(), project: null, name: null, profile: null, json: false, remote: 'origin', push: true, force: false, apply: false, once: false, done: false, undone: false, unreported: false, guided: false, new: false, status: undefined, owner: undefined, summary: '', scope: null, priority: 'mid', reviewers: [], stakeholders: [], links: [], acceptance: [], related: [], excludes: [], functionIds: [], traits: [], policy: { required: [], recommended: [], onDemand: [], disabled: [] }, policySpecified: false, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--json') options.json = true;
    else if (value === '--guided') options.guided = true;
    else if (value === '--new') options.new = true;
    else if (value === '--no-push') options.push = false;
    else if (value === '--force') options.force = true;
    else if (value === '--apply') options.apply = true;
    else if (value === '--once') options.once = true;
    else if (value === '--done') options.done = true;
    else if (value === '--undone') options.undone = true;
    else if (value === '--unreported') options.unreported = true;
    else if (['--root', '--project', '--name', '--profile', '--enforcement', '--trait', '--required', '--recommended', '--on-demand', '--disabled', '--type', '--remote', '--status', '--owner', '--summary', '--scope', '--exclude', '--function-id', '--priority', '--reviewer', '--stakeholder', '--link', '--acceptance', '--related', '--domain', '--feature', '--strategy', '--client-id', '--max-items', '--interval', '--input-tokens', '--output-tokens', '--cached-tokens', '--model', '--provider', '--client', '--git-url', '--planned-executor', '--actual-executor', '--artifact-id', '--task-id', '--fallback-reason'].includes(value)) {
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
      else if (value === '--scope') options.scope = argv[i];
      else if (value === '--exclude') options.excludes.push(argv[i]);
      else if (value === '--function-id') options.functionIds.push(argv[i]);
      else if (value === '--priority') options.priority = argv[i];
      else if (value === '--reviewer') options.reviewers.push(argv[i]);
      else if (value === '--stakeholder') options.stakeholders.push(argv[i]);
      else if (value === '--link') options.links.push(argv[i]);
      else if (value === '--acceptance') options.acceptance.push(argv[i]);
      else if (value === '--related') options.related.push(argv[i]);
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

function printOperation(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const [key, value] of Object.entries(result)) {
      if (value !== undefined && value !== null && typeof value !== 'object') process.stdout.write(`${key}: ${value}\n`);
    }
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
    if (options.guided) {
      const guided = await guidedProjectInput({ key: options.positional[0], name: options.name, profile: options.profile, traits: options.traits });
      options.positional = [guided.key];
      options.name = guided.name;
      options.profile = guided.profile;
      options.traits = guided.traits;
    }
    if (!options.new && options.positional.length === 0) throw new Error('새 Workspace 생성에는 --new 또는 위치 프로젝트 키가 필요합니다.');
    if ((options.traits.length || options.policySpecified) && !options.profile) throw new Error('--trait 또는 policy override를 사용하려면 --profile이 필요합니다.');
    if (options.profile && !PROFILE_NAMES.includes(options.profile)) throw new Error(`지원하지 않는 문서 프로필입니다: ${options.profile}`);
    if (options.positional.length !== 1) throw new Error('rdl init에는 프로젝트 키 하나가 필요합니다.');
    const initialized = initializeWorkspace(options.root, options.positional[0], options.name);
    const selectedProfile = options.profile || 'service';
    const configuredProfile = applyToProject(path.join(initialized.projectRoot, 'project.md'), { schemaVersion: 2, name: selectedProfile, enforcement: options.enforcement || 'checkpoint', traits: options.traits, policy: options.policySpecified ? options.policy : undefined }).profile;
    const git = initState(initialized.root, { project: initialized.project });
    initObsidian(initialized.root, { project: initialized.project, force: false });
    const contract = loadDocumentContract(initialized.root, initialized.project);
    printOperation(Object.assign({ action: 'created', profile: selectedProfile, traits: configuredProfile.traits, missing: missingActions(configuredProfile, []), contract }, initialized, { branch: git.branch, worktree: git.worktree, boundary: git.boundary }), options.json);
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
      if (!PROFILE_NAMES.includes(profileOptions.profile)) throw new Error('--profile <lean|product|service|platform|assured>가 필요합니다.');
      const { workspaceLayout, selectProject } = require('../src/workspace');
      const layout = workspaceLayout(profileOptions.root);
      const selected = selectProject(layout, profileOptions.project, true);
      const updated = reconfigureProject(selected.charter, profileOptions.profile, {
        enforcement: profileOptions.enforcement,
        traits: profileOptions.traits.length ? profileOptions.traits : undefined,
        policy: profileOptions.policySpecified ? profileOptions.policy : undefined
      });
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
    if (!['plan', 'set'].includes(subcommand)) throw new Error('지원하는 contract 하위 명령은 show, next, check, trace, plan, set입니다.');
    if (!PROFILE_NAMES.includes(options.profile)) throw new Error('--profile <lean|product|service|platform|assured>가 필요합니다.');
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
  if (command === 'task') {
    const subcommand = argv.shift();
    if (!['add', 'set', 'acceptance', 'migrate'].includes(subcommand)) throw new Error('지원하는 태스크 하위 명령은 add, set, acceptance, migrate입니다.');
    const options = parseOperationArgs(argv);
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
    if (Object.keys(changes).length === 0) throw new Error('--status 또는 --owner 중 하나가 필요합니다.');
    const result = taskSet(options.root, options.positional[0], changes, options.project);
    printOperation(result, options.json);
    if (DEBUG_CONTEXT) recordAction(options.root, { action: 'task.update', actualExecutor: 'cli', taskId: options.positional[0] });
    return 0;
  }
  if (command === 'doc') {
    const subcommand = argv.shift();
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
