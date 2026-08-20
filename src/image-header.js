'use strict';

// 이미지 헤더 판독. require를 하나도 갖지 않는다 — 판정 계층이 이 모듈을 부르므로
// 그 순수성이 여기까지 이어져야 한다.
//
// 차원을 알려고 이미지를 디코딩하지 않는다. 디코딩이 필요한 것은 변환이지
// 판정이 아니며, 판정에 코덱을 들이면 판정이 무거워지고 형식마다 답이 갈린다.
// 헤더 몇 바이트면 네 형식 모두 차원이 나온다.

/** 정본에 넣을 수 있는 자산 확장자. 소문자로 비교한다. */
const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

/** 확장자가 자산을 가리키는가. 문서 참조와 자산 embed를 가르는 기준이다. */
function isAssetPath(value) {
  const text = String(value || '').toLowerCase();
  const dot = text.lastIndexOf('.');
  return dot > 0 && ASSET_EXTENSIONS.includes(text.slice(dot));
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.slice(12, 16).toString('latin1') !== 'IHDR') return null;
  return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    // SOF0~SOF15 중 DHT(c4)·JPG(c8)·DAC(cc)를 뺀 것이 크기를 담는다.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { format: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function gifSize(buffer) {
  if (buffer.length < 10 || buffer.slice(0, 3).toString('latin1') !== 'GIF') return null;
  return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function webpSize(buffer) {
  if (buffer.length < 30 || buffer.slice(0, 4).toString('latin1') !== 'RIFF') return null;
  if (buffer.slice(8, 12).toString('latin1') !== 'WEBP') return null;
  const chunk = buffer.slice(12, 16).toString('latin1');
  if (chunk === 'VP8X') return { format: 'webp', width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  if (chunk === 'VP8 ') return { format: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { format: 'webp', width: null, height: null };
}

// SVG는 텍스트라 차원이 없을 수도 있다. 없으면 없다고 답한다 — 0으로 답하면
// "매우 작은 이미지"로 읽혀 임계 판정을 통과한다.
function svgSize(buffer) {
  const head = buffer.slice(0, 2048).toString('utf8');
  if (!/<svg[\s>]/iu.test(head)) return null;
  const width = /\bwidth\s*=\s*["']\s*([0-9.]+)/iu.exec(head);
  const height = /\bheight\s*=\s*["']\s*([0-9.]+)/iu.exec(head);
  return {
    format: 'svg',
    width: width ? Math.round(Number(width[1])) : null,
    height: height ? Math.round(Number(height[1])) : null
  };
}

/**
 * 바이트에서 형식과 차원을 읽는다. 알아보지 못하면 null이다.
 * 값만 받고 값만 돌려주므로 같은 바이트면 언제나 같은 답이다.
 */
function imageSize(buffer) {
  if (!buffer || typeof buffer.readUInt32BE !== 'function') return null;
  return pngSize(buffer) || jpegSize(buffer) || gifSize(buffer) || webpSize(buffer) || svgSize(buffer) || null;
}

module.exports = { ASSET_EXTENSIONS, isAssetPath, imageSize };
