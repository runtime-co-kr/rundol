'use strict';

// PNG 디코드·축소·인코드. 의존성은 Node 내장 zlib 하나다.
//
// 외부 라이브러리를 쓰지 않은 이유는 취향이 아니라 계약이다. Rundol은 외부 runtime
// dependency 없이 동작한다고 약속했고, 지금 네이티브 의존성이 0개다. sharp 같은
// 것은 플랫폼별 바이너리를 설치 스크립트로 받아오므로 그 약속과 네 OS 매트릭스를
// 동시에 깬다.
//
// PNG만 다루는 이유도 같다. PNG는 zlib으로 압축된 스캔라인이라 내장 모듈로
// 끝나지만, JPEG는 허프만과 역이산코사인변환을 직접 구현해야 한다. 그것은 이
// 파일이 감당할 크기가 아니고, 감당하는 척하면 조용히 틀린 그림이 나온다.
// 화면 갈무리는 거의 언제나 PNG이므로 실제 쓰임의 대부분이 여기 들어온다.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 색 유형별 표본 수. 팔레트(3)는 표본이 하나지만 그 값이 색인이라 따로 다룬다.
const SAMPLES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

class PngError extends Error {
  constructor(message) { super(message); this.name = 'PngError'; }
}

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC = crcTable();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── 디코드 ───────────────────────────────────────────────────────────────

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.slice(0, 8).equals(SIGNATURE)) throw new PngError('PNG 서명이 아닙니다.');
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.slice(offset + 4, offset + 8).toString('latin1');
    const start = offset + 8;
    if (start + length + 4 > buffer.length) throw new PngError(`잘린 청크입니다: ${type}`);
    chunks.push({ type, data: buffer.slice(start, start + length) });
    offset = start + length + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// 필터를 되돌린다. 다섯 유형 전부를 다루지 않으면 어떤 인코더가 만든 파일에서만
// 동작하는 디코더가 되고, 그 사실은 남의 스크린샷을 받았을 때 처음 드러난다.
function undoFilters(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const line = out.slice(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x];
      const a = x >= bytesPerPixel ? line[x - bytesPerPixel] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bytesPerPixel ? prior[x - bytesPerPixel] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + a;
      else if (filter === 2) restored = value + b;
      else if (filter === 3) restored = value + ((a + b) >> 1);
      else if (filter === 4) restored = value + paeth(a, b, c);
      else throw new PngError(`알 수 없는 필터 유형입니다: ${filter}`);
      line[x] = restored & 0xff;
    }
    source += stride;
  }
  return out;
}

/**
 * PNG 바이트를 8비트 RGBA 화소 배열로 편다.
 * 인터레이스와 16비트 깊이는 다루지 않는다 — 다루는 척하는 것보다 거절이 낫다.
 */
function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const header = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!header) throw new PngError('IHDR가 없습니다.');
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const depth = header.data[8];
  const colorType = header.data[9];
  const interlace = header.data[12];
  if (interlace !== 0) throw new PngError('인터레이스 PNG는 다루지 않습니다.');
  if (depth !== 8) throw new PngError(`8비트 깊이만 다룹니다: ${depth}비트`);
  if (!Object.prototype.hasOwnProperty.call(SAMPLES, colorType)) throw new PngError(`알 수 없는 색 유형입니다: ${colorType}`);

  const bytesPerPixel = SAMPLES[colorType];
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (compressed.length === 0) throw new PngError('IDAT가 없습니다.');
  const raw = zlib.inflateSync(compressed);
  const planar = undoFilters(raw, width, height, bytesPerPixel);

  const palette = chunks.find((chunk) => chunk.type === 'PLTE');
  const alpha = chunks.find((chunk) => chunk.type === 'tRNS');
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const from = index * bytesPerPixel;
    const to = index * 4;
    if (colorType === 0) { const g = planar[from]; pixels[to] = g; pixels[to + 1] = g; pixels[to + 2] = g; pixels[to + 3] = 255; }
    else if (colorType === 2) { pixels[to] = planar[from]; pixels[to + 1] = planar[from + 1]; pixels[to + 2] = planar[from + 2]; pixels[to + 3] = 255; }
    else if (colorType === 3) {
      if (!palette) throw new PngError('팔레트 PNG에 PLTE가 없습니다.');
      const entry = planar[from] * 3;
      pixels[to] = palette.data[entry]; pixels[to + 1] = palette.data[entry + 1]; pixels[to + 2] = palette.data[entry + 2];
      pixels[to + 3] = alpha && planar[from] < alpha.data.length ? alpha.data[planar[from]] : 255;
    } else if (colorType === 4) { const g = planar[from]; pixels[to] = g; pixels[to + 1] = g; pixels[to + 2] = g; pixels[to + 3] = planar[from + 1]; }
    else { pixels[to] = planar[from]; pixels[to + 1] = planar[from + 1]; pixels[to + 2] = planar[from + 2]; pixels[to + 3] = planar[from + 3]; }
  }
  return { width, height, pixels };
}

// ── 축소 ─────────────────────────────────────────────────────────────────

/**
 * 상자 필터로 줄인다. 최근접 이웃은 글자가 깨지고 화면 갈무리는 대부분 글자다.
 * 알파를 곱해 섞지 않으면 투명한 화소의 색이 가장자리로 번진다.
 */
function resizeRgba(image, targetWidth, targetHeight) {
  const width = Math.max(1, Math.round(targetWidth));
  const height = Math.max(1, Math.round(targetHeight));
  const out = Buffer.alloc(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));
      let r = 0; let g = 0; let b = 0; let a = 0; let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * image.width + sx) * 4;
          const weight = image.pixels[at + 3] / 255;
          r += image.pixels[at] * weight;
          g += image.pixels[at + 1] * weight;
          b += image.pixels[at + 2] * weight;
          a += image.pixels[at + 3];
          count += 1;
        }
      }
      const alpha = a / count;
      const share = alpha > 0 ? (count * alpha) / 255 : 1;
      const to = (y * width + x) * 4;
      out[to] = Math.min(255, Math.round(r / share));
      out[to + 1] = Math.min(255, Math.round(g / share));
      out[to + 2] = Math.min(255, Math.round(b / share));
      out[to + 3] = Math.round(alpha);
    }
  }
  return { width, height, pixels: out };
}

// ── 인코드 ───────────────────────────────────────────────────────────────

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

// 줄마다 다섯 필터를 시험해 절대값 합이 가장 작은 것을 고른다. PNG 명세가 권하는
// 어림짐작이고, 화면 갈무리처럼 가로로 평평한 그림에서 특히 크게 줄어든다.
function filterLine(line, prior, bytesPerPixel) {
  const candidates = [];
  for (let type = 0; type <= 4; type += 1) {
    const encoded = Buffer.alloc(line.length);
    let score = 0;
    for (let x = 0; x < line.length; x += 1) {
      const a = x >= bytesPerPixel ? line[x - bytesPerPixel] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bytesPerPixel ? prior[x - bytesPerPixel] : 0;
      let value;
      if (type === 0) value = line[x];
      else if (type === 1) value = line[x] - a;
      else if (type === 2) value = line[x] - b;
      else if (type === 3) value = line[x] - ((a + b) >> 1);
      else value = line[x] - paeth(a, b, c);
      encoded[x] = value & 0xff;
      score += Math.min(encoded[x], 256 - encoded[x]);
    }
    candidates.push({ type, encoded, score });
  }
  return candidates.reduce((best, item) => (item.score < best.score ? item : best));
}

/**
 * RGBA 화소를 PNG 바이트로 만든다. 알파가 전부 불투명하면 RGB로 저장한다 —
 * 화면 갈무리는 거의 언제나 그렇고, 그것만으로 4분의 1이 줄어든다.
 */
function encodePng(image) {
  let opaque = true;
  for (let index = 3; index < image.pixels.length; index += 4) {
    if (image.pixels[index] !== 255) { opaque = false; break; }
  }
  const bytesPerPixel = opaque ? 3 : 4;
  const stride = image.width * bytesPerPixel;
  const body = Buffer.alloc((stride + 1) * image.height);
  let prior = null;
  for (let y = 0; y < image.height; y += 1) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < image.width; x += 1) {
      const from = (y * image.width + x) * 4;
      const to = x * bytesPerPixel;
      line[to] = image.pixels[from];
      line[to + 1] = image.pixels[from + 1];
      line[to + 2] = image.pixels[from + 2];
      if (!opaque) line[to + 3] = image.pixels[from + 3];
    }
    const chosen = filterLine(line, prior, bytesPerPixel);
    body[y * (stride + 1)] = chosen.type;
    chosen.encoded.copy(body, y * (stride + 1) + 1);
    prior = line;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(body, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 긴 변이 한계를 넘으면 비율을 지켜 줄이고 다시 인코드한다. 넘지 않으면
 * 원본 바이트를 그대로 돌려준다 — 줄일 필요가 없는데 다시 인코드하면
 * 손대지 않아도 될 파일이 매번 다른 바이트가 되어 diff가 무의미해진다.
 */
function shrinkPng(buffer, maxEdge) {
  const image = decodePng(buffer);
  const longest = Math.max(image.width, image.height);
  if (!maxEdge || longest <= maxEdge) {
    return { changed: false, buffer, width: image.width, height: image.height, from: { width: image.width, height: image.height } };
  }
  const ratio = maxEdge / longest;
  const resized = resizeRgba(image, image.width * ratio, image.height * ratio);
  return {
    changed: true,
    buffer: encodePng(resized),
    width: resized.width,
    height: resized.height,
    from: { width: image.width, height: image.height }
  };
}

module.exports = { PngError, decodePng, encodePng, resizeRgba, shrinkPng };
