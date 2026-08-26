'use strict';

// Board 화면을 캡처한다. 시험이 아니라 눈으로 보기 위한 도구다.
//
// 흐름도처럼 "그려지긴 했는데 보기에 맞는가"를 묻는 것은 문자열 시험이 답하지 못한다.
// 실제로 이 화면은 태그도 g도 text도 다 제자리에 있는 채로 크기만 0으로 접혀 있었고,
// 그 상태에서 아무 오류도 나지 않았다 — 열어 보기 전에는 드러나지 않는 종류다.
//
//   node scripts/board-shot.js <url> <출력.png> [--dark] [--section <id>]

const { chromium } = require('playwright');

async function main() {
  const [url, out] = process.argv.slice(2);
  if (!url || !out) throw new Error('사용법: node scripts/board-shot.js <url> <출력.png> [--dark] [--section <id>]');
  const dark = process.argv.includes('--dark');
  const sectionAt = process.argv.indexOf('--section');
  const section = sectionAt === -1 ? 'workflow-settings' : process.argv[sectionAt + 1];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.click('[data-view="settings"]').catch(() => {});
    await page.waitForTimeout(400);
    if (dark) await page.evaluate(() => { const button = document.getElementById('theme-dark'); if (button) button.click(); });
    await page.click(`[data-settings-section="${section}"]`).catch(() => {});
    // mermaid는 화면에 올라온 뒤에 상자를 잰다. 재는 동안 찍으면 접힌 그림이 나온다.
    await page.waitForTimeout(2000);
    const host = await page.$(`#${section === 'workflow-settings' ? 'workflow-diagram' : section}`);
    if (host) {
      await host.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await host.screenshot({ path: out });
      const box = await (await page.$(`#${'workflow-diagram'} svg`))?.boundingBox();
      process.stdout.write(`${out} · svg ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '없음'}\n`);
    } else {
      await page.screenshot({ path: out, fullPage: true });
      process.stdout.write(`${out} · 전체 화면 (대상 없음)\n`);
    }
    if (errors.length) process.stdout.write(`페이지 오류: ${errors.slice(0, 3).join(' · ')}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
