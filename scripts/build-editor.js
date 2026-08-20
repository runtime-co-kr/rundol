'use strict';

// 문서 편집기 번들을 만든다.
//
// 보드 화면은 빌드 없이 node_modules의 완성 파일을 그대로 내려보내 왔다. 편집기는
// ProseMirror와 remark 위에 서므로 그 방식이 통하지 않는다 — 의존 그래프가 깊고
// 전부 ESM이라 브라우저가 bare specifier를 풀 수 없다.
//
// 그래서 여기서만 번들을 만든다. 산출물은 저장소에 두지 않는다. 커밋된 번들은
// 소스와 어긋나도 아무도 모르고, 어긋난 뒤에는 어느 쪽이 맞는지 다투게 된다.
//
// esbuild는 devDependency다. 발행되는 패키지의 실행 의존성은 이 일로 늘지 않는다 —
// 배포물에 들어가는 것은 만들어진 번들 하나뿐이다.

const fs = require('fs');
const path = require('path');

const repository = path.resolve(__dirname, '..');
const entry = path.join(repository, 'src', 'board-ui', 'editor', 'entry.mjs');
const outdir = path.join(repository, 'src', 'board-ui', 'generated');

function build({ quiet } = {}) {
  let esbuild;
  try {
    // JS API를 쓴다. 실행 파일을 셸로 부르면 Windows에서 인자가 escape 없이
    // 이어 붙고, Node가 그것을 경고한다. 여기서 셸을 지날 이유가 없다.
    esbuild = require('esbuild');
  } catch (_) {
    // 설치 없이 tarball만 푼 경우다. 여기서 죽으면 설치 자체가 실패하므로
    // 무엇이 없어서 무엇을 못 만들었는지만 말하고 물러난다.
    process.stderr.write('editor: esbuild가 없어 번들을 만들지 못했습니다. npm install 후 다시 시도하세요.\n');
    return false;
  }

  fs.mkdirSync(outdir, { recursive: true });
  try {
    esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: 'iife',
      outdir,
      loader: { '.css': 'css', '.woff': 'dataurl', '.woff2': 'dataurl' },
      logLevel: 'warning',
      absWorkingDir: repository
    });
  } catch (error) {
    process.stderr.write(`editor: 번들 생성에 실패했습니다. ${error.message}\n`);
    return false;
  }

  if (!quiet) {
    for (const name of fs.readdirSync(outdir)) {
      const bytes = fs.statSync(path.join(outdir, name)).size;
      process.stdout.write(`editor: ${name} ${Math.round(bytes / 1024)}KB\n`);
    }
  }
  return true;
}

if (require.main === module) {
  process.exitCode = build() ? 0 : 1;
}

module.exports = { build, outdir };
