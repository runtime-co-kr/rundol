'use strict';

// 자산 시험. 정본 문서에 그림을 넣을 수 있어야 하고, 큰 그림은 넣는 순간 줄어야
// 하며, 줄이지 못하는 형식은 줄인 척하지 않아야 한다.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { imageSize, isAssetPath } = require('../src/image-header');
const { decodePng, encodePng, shrinkPng } = require('../src/png-codec');
const { shrinkImage, ShrinkError } = require('../src/image-shrink');

const repository = path.resolve(__dirname, '..');
const cli = path.join(repository, 'bin', 'rdl.js');

// ── 헤더 판독 ────────────────────────────────────────────────────────────
//
// 차원을 알려고 디코딩하지 않는다. 디코딩이 필요한 것은 변환이지 판정이 아니며,
// 판정에 코덱을 들이면 형식마다 답이 갈린다.

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

assert.deepStrictEqual(imageSize(pngHeader(3840, 2160)), { format: 'png', width: 3840, height: 2160 });

const gif = Buffer.alloc(10);
gif.write('GIF89a', 0, 'latin1');
gif.writeUInt16LE(800, 6);
gif.writeUInt16LE(600, 8);
assert.deepStrictEqual(imageSize(gif), { format: 'gif', width: 800, height: 600 });

const jpegHeader = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]),
  (() => { const b = Buffer.alloc(4); b.writeUInt16BE(1080, 0); b.writeUInt16BE(1920, 2); return b; })(),
  Buffer.alloc(8)
]);
assert.deepStrictEqual(imageSize(jpegHeader), { format: 'jpeg', height: 1080, width: 1920 });

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"></svg>', 'utf8');
assert.deepStrictEqual(imageSize(svg), { format: 'svg', width: 400, height: 300 });

// 알아보지 못한 것은 0이 아니라 없음이다. 0으로 답하면 "매우 작은 이미지"로 읽혀
// 크기 판정을 그대로 통과한다.
assert.strictEqual(imageSize(Buffer.from('not an image at all')), null);
assert.strictEqual(imageSize(null), null);

// 확장자가 문서 참조와 자산 embed를 가른다.
assert.strictEqual(isAssetPath('diagram.png'), true);
assert.strictEqual(isAssetPath('photo.JPG'), true);
assert.strictEqual(isAssetPath('REQ-001'), false);
assert.strictEqual(isAssetPath('ADR-004-깃-참조와-작업-트리-소유-경계'), false);

// ── PNG 코덱 ─────────────────────────────────────────────────────────────

function checkerboard(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const ink = (x % 16 < 3) || (y % 16 < 3);
      pixels[at] = ink ? 20 : 250;
      pixels[at + 1] = ink ? 30 : 245;
      pixels[at + 2] = ink ? 40 : 240;
      pixels[at + 3] = 255;
    }
  }
  return { width, height, pixels };
}

// 왕복이 무손실이어야 한다. 인코더와 디코더가 서로만 알아듣는 방언을 쓰면
// 남이 만든 화면 갈무리에서 처음 드러난다.
{
  const source = checkerboard(320, 200);
  const decoded = decodePng(encodePng(source));
  assert.strictEqual(decoded.width, source.width);
  assert.strictEqual(decoded.height, source.height);
  assert.ok(decoded.pixels.equals(source.pixels), 'PNG 왕복이 무손실이 아닙니다.');
}

// 투명도가 있으면 알파를 보존해야 한다. 잃으면 투명한 배경이 검게 나온다.
{
  const source = checkerboard(32, 32);
  source.pixels[3] = 0;
  assert.strictEqual(decodePng(encodePng(source)).pixels[3], 0, '알파가 사라졌습니다.');
}

// 다섯 필터 유형을 모두 되돌려야 한다. 인코더가 줄마다 다른 필터를 고르므로
// 하나라도 못 되돌리면 자기가 만든 파일도 못 읽는다.
{
  const wide = checkerboard(200, 40);
  const decoded = decodePng(encodePng(wide));
  assert.ok(decoded.pixels.equals(wide.pixels), '필터 왕복이 깨졌습니다.');
}

// 한계 이하면 손대지 않는다. 다시 인코딩하면 손대지 않아도 될 파일이 매번 다른
// 바이트가 되어 diff가 무의미해진다.
{
  const small = encodePng(checkerboard(400, 300));
  const result = shrinkPng(small, 1600);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.buffer, small, '줄일 필요가 없는데 다시 인코딩했습니다.');
}

// ── 축소 ─────────────────────────────────────────────────────────────────

{
  const big = encodePng(checkerboard(3200, 1800));
  const result = shrinkImage(big, { maxEdge: 1600 });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.format, 'png');
  assert.strictEqual(result.width, 1600);
  assert.strictEqual(result.height, 900, '비율이 지켜지지 않았습니다.');
  assert.ok(result.buffer.length < big.length, '줄였는데 커졌습니다.');
  assert.deepStrictEqual(imageSize(result.buffer), { format: 'png', width: 1600, height: 900 });
}

// JPEG도 줄어야 한다. 사진은 JPEG로 들어오고, 그것을 못 줄이면 사람이 직접
// 줄여야 하는 경우가 남는다.
{
  const jpeg = require('jpeg-js');
  const source = checkerboard(2400, 1600);
  const encoded = Buffer.from(jpeg.encode({ data: source.pixels, width: source.width, height: source.height }, 90).data);
  const result = shrinkImage(encoded, { maxEdge: 800 });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.format, 'jpeg');
  assert.strictEqual(result.width, 800);
  assert.ok(result.buffer.length < encoded.length, 'JPEG를 줄였는데 커졌습니다.');
  assert.deepStrictEqual(imageSize(result.buffer), { format: 'jpeg', width: 800, height: 533 });
}

// 벡터는 줄일 일이 없다. 확대해도 깨지지 않는 것이 벡터의 뜻이다.
assert.strictEqual(shrinkImage(svg, { maxEdge: 100 }).changed, false);

// 줄이지 못하는 형식은 줄인 척하지 않는다. 원본을 그대로 통과시키면 사람은
// 줄었겠지 하고 넘어가고, 그 파일은 저장소에 남는다.
{
  const wide = Buffer.alloc(10);
  wide.write('GIF89a', 0, 'latin1');
  wide.writeUInt16LE(4000, 6);
  wide.writeUInt16LE(3000, 8);
  assert.throws(() => shrinkImage(wide, { maxEdge: 1600 }), (error) => error instanceof ShrinkError && error.format === 'gif');
  // 한계 안이면 그대로 통과한다 — 줄일 이유가 없으므로 거절할 이유도 없다.
  const small = Buffer.alloc(10);
  small.write('GIF89a', 0, 'latin1');
  small.writeUInt16LE(200, 6);
  small.writeUInt16LE(100, 8);
  assert.strictEqual(shrinkImage(small, { maxEdge: 1600 }).changed, false);
}

assert.throws(() => shrinkImage(Buffer.from('nope'), { maxEdge: 100 }), ShrinkError);

// ── 명령과 검사 ──────────────────────────────────────────────────────────

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rundol-asset-'));
try {
  const env = Object.assign({}, process.env, { RUNDOL_HOME: path.join(temporary, 'runtime') });
  const run = (args, cwd) => spawnSync(process.execPath, [cli].concat(args), { cwd: cwd || repository, encoding: 'utf8', env });
  const setup = (program, args) => {
    const done = spawnSync(program, args, { cwd: temporary, encoding: 'utf8', env });
    assert.strictEqual(done.status, 0, `${program} ${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
  };
  setup('git', ['init', '-b', 'main']);
  setup('git', ['config', 'user.name', 'Rundol Test']);
  setup('git', ['config', 'user.email', 'rundol@example.test']);
  fs.writeFileSync(path.join(temporary, 'README.md'), '# asset\n', 'utf8');
  setup('git', ['add', 'README.md']);
  setup('git', ['commit', '-m', 'initial']);
  const created = run(['init', 'crm', '--name', 'CRM', '--profile', 'lean', '--root', temporary, '--json']);
  assert.strictEqual(created.status, 0, created.stderr || created.stdout);

  const inbox = path.join(temporary, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  // 이름에 공백과 대문자와 한글을 섞는다. Obsidian embed와 URL 인코딩에서 갈리는
  // 이름이 그대로 들어오면, 그 차이는 사람이 눈으로 못 본다.
  const inputFile = path.join(inbox, '큰 화면 갈무리.PNG');
  fs.writeFileSync(inputFile, encodePng(checkerboard(3200, 1800)));

  const added = JSON.parse(run(['asset', 'add', inputFile, '--project', 'crm', '--root', temporary, '--json']).stdout);
  assert.strictEqual(added.changed, true);
  assert.strictEqual(added.resized, true, '한계를 넘는 그림이 줄지 않았습니다.');
  assert.strictEqual(added.width, 1600);
  assert.strictEqual(added.name, '큰-화면-갈무리.png', '자산 이름이 정규화되지 않았습니다.');
  assert.strictEqual(added.embed, '![[큰-화면-갈무리.png]]', '붙여 넣을 embed를 돌려주어야 합니다.');
  assert.ok(fs.existsSync(added.file), '자산 파일이 만들어지지 않았습니다.');

  // 같은 이름을 다시 넣으면 덮지 않고 이름을 늘린다. 덮으면 다른 문서가 가리키던
  // 그림이 말없이 바뀐다.
  const again = JSON.parse(run(['asset', 'add', inputFile, '--project', 'crm', '--root', temporary, '--json']).stdout);
  assert.strictEqual(again.name, '큰-화면-갈무리-2.png', '같은 이름의 자산을 덮었습니다.');

  const listed = JSON.parse(run(['asset', 'list', '--project', 'crm', '--root', temporary, '--json']).stdout);
  assert.strictEqual(listed.count, 2);
  assert.ok(listed.bytes > 0);

  // embed는 문서 참조가 아니다. 이것이 링크 규칙에 걸리면 정본에 그림을 넣을 수 없다.
  const charter = path.join(temporary, 'projects', 'crm', 'project.md');
  fs.appendFileSync(charter, `\n## 그림\n\n${added.embed}\n`, 'utf8');
  const clean = run(['check', '--project', 'crm', '--root', temporary, '--json']);
  const cleanReport = JSON.parse(clean.stdout);
  const linkNoise = cleanReport.diagnostics.filter((item) => item.code === 'RDL-LINK-004' && String(item.target || '').endsWith('.png'));
  assert.deepStrictEqual(linkNoise, [], 'embed가 해결되지 않은 문서 참조로 잡혔습니다.');
  // 참조된 자산은 고아가 아니다.
  const referenced = cleanReport.diagnostics.filter((item) => item.code === 'RDL-ASSET-005' && item.target === added.name);
  assert.deepStrictEqual(referenced, [], '참조된 자산이 고아로 잡혔습니다.');
  // 참조되지 않은 두 번째 자산은 고아다.
  assert.ok(
    cleanReport.diagnostics.some((item) => item.code === 'RDL-ASSET-005' && item.target === again.name),
    '참조되지 않은 자산이 잡히지 않았습니다.'
  );

  // 없는 자산을 가리키면 잡아야 한다. 끊긴 그림은 사람이 문서를 열어야만 보인다.
  fs.appendFileSync(charter, '\n![[없는그림.png]]\n', 'utf8');
  const broken = JSON.parse(run(['check', '--project', 'crm', '--root', temporary, '--json']).stdout);
  const missing = broken.diagnostics.filter((item) => item.code === 'RDL-ASSET-001');
  assert.strictEqual(missing.length, 1, '해결되지 않은 자산 참조가 잡히지 않았습니다.');
  assert.strictEqual(missing[0].target, '없는그림.png');
  // strict에서는 오류다. 경고로 두면 끊긴 그림이 있는 채로 저장과 동기화가 통과한다.
  const strict = JSON.parse(run(['check', '--project', 'crm', '--root', temporary, '--strict', '--json']).stdout);
  assert.strictEqual(
    strict.diagnostics.find((item) => item.code === 'RDL-ASSET-001').severity,
    'error',
    'strict에서 끊긴 자산 참조가 오류가 아닙니다.'
  );

  // 자산으로 넣을 수 없는 것은 거절한다.
  const notImage = path.join(inbox, 'notes.txt');
  fs.writeFileSync(notImage, 'not an image', 'utf8');
  const rejected = run(['asset', 'add', notImage, '--project', 'crm', '--root', temporary, '--json']);
  assert.notStrictEqual(rejected.status, 0, '이미지가 아닌 파일이 자산으로 들어갔습니다.');
  assert.ok(rejected.stderr.includes('png'), '거절 사유가 무엇을 넣을 수 있는지 말해야 합니다.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write('asset tests passed\n');
