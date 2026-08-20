'use strict';

// 자산 축소. 큰 그림을 사람이 매번 줄여서 넣으라고 하면 아무도 안 쓴다.
//
// PNG는 내장 zlib으로 직접 다루고(png-codec.js), JPEG는 jpeg-js로 다룬다.
// jpeg-js를 고른 이유는 76KB에 자체 의존성이 0이고 순수 JavaScript이기 때문이다.
// sharp는 958KB에 플랫폼별 네이티브 바이너리를 설치 스크립트로 받아오므로,
// 네 OS 매트릭스와 "설치 스크립트를 두지 않는다"는 릴리즈 검사를 동시에 깬다.
//
// GIF와 WebP는 재지 않고 줄이지도 않는다. GIF는 LZW라 zlib이 닿지 않고 대개
// 애니메이션이라 한 장으로 줄이면 뜻이 바뀐다. WebP는 영상 코덱이라 순수
// JavaScript로 감당할 크기가 아니다. 줄이지 못하는 것은 줄인 척하지 않고
// 왜 못 줄이는지를 말한다.

const { decodePng, encodePng, resizeRgba, shrinkPng } = require('./png-codec');
const { imageSize } = require('./image-header');

/** 문서에 넣을 그림의 긴 변 기본 한계. 레티나 갈무리가 이 두 배로 찍힌다. */
const DEFAULT_MAX_EDGE = 1600;
/** JPEG 재인코딩 품질. 화면 갈무리와 사진 모두에서 눈에 띄는 열화가 없는 값이다. */
const DEFAULT_JPEG_QUALITY = 82;

class ShrinkError extends Error {
  constructor(message, format) {
    super(message);
    this.name = 'ShrinkError';
    this.format = format || null;
  }
}

function shrinkJpeg(buffer, maxEdge, quality) {
  const jpeg = require('jpeg-js');
  const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  const longest = Math.max(decoded.width, decoded.height);
  const image = { width: decoded.width, height: decoded.height, pixels: Buffer.from(decoded.data) };
  if (!maxEdge || longest <= maxEdge) {
    // 줄일 필요가 없으면 원본 바이트를 그대로 돌려준다. 다시 인코딩하면 손대지
    // 않아도 될 파일이 매번 다른 바이트가 되어 diff가 무의미해진다.
    return { changed: false, buffer, format: 'jpeg', width: image.width, height: image.height, from: { width: image.width, height: image.height } };
  }
  const ratio = maxEdge / longest;
  const resized = resizeRgba(image, image.width * ratio, image.height * ratio);
  const encoded = jpeg.encode({ data: resized.pixels, width: resized.width, height: resized.height }, quality || DEFAULT_JPEG_QUALITY);
  return {
    changed: true,
    buffer: Buffer.from(encoded.data),
    format: 'jpeg',
    width: resized.width,
    height: resized.height,
    from: { width: image.width, height: image.height }
  };
}

/**
 * 긴 변이 한계를 넘으면 비율을 지켜 줄인다.
 *
 * 줄이지 못하는 형식은 예외로 알린다. 원본을 그대로 통과시키면 "줄었겠지" 하고
 * 넘어가고, 그 파일은 저장소에 남는다. 못 하는 일은 못 한다고 말해야 사람이
 * 다른 수를 낸다.
 */
function shrinkImage(buffer, options) {
  const settings = options || {};
  const maxEdge = settings.maxEdge === undefined ? DEFAULT_MAX_EDGE : settings.maxEdge;
  const probe = imageSize(buffer);
  const format = probe ? probe.format : null;

  if (format === 'png') return Object.assign({ format: 'png' }, shrinkPng(buffer, maxEdge));
  if (format === 'jpeg') return shrinkJpeg(buffer, maxEdge, settings.quality);
  // 벡터는 줄일 일이 없다. 확대해도 깨지지 않는 것이 벡터의 뜻이다.
  if (format === 'svg') {
    return { changed: false, buffer, format: 'svg', width: probe.width, height: probe.height, from: { width: probe.width, height: probe.height } };
  }
  if (format === 'gif' || format === 'webp') {
    const longest = Math.max(probe.width || 0, probe.height || 0);
    if (maxEdge && longest > maxEdge) {
      throw new ShrinkError(
        `${format.toUpperCase()}는 자동 축소를 지원하지 않습니다. ${probe.width}x${probe.height}를 긴 변 ${maxEdge}px 이하로 줄여서 다시 넣거나, PNG로 저장해 넣으세요.`,
        format
      );
    }
    return { changed: false, buffer, format, width: probe.width, height: probe.height, from: { width: probe.width, height: probe.height } };
  }
  throw new ShrinkError('이미지 형식을 알아보지 못했습니다. PNG, JPEG, GIF, WebP, SVG만 자산으로 넣을 수 있습니다.', null);
}

module.exports = { DEFAULT_MAX_EDGE, DEFAULT_JPEG_QUALITY, ShrinkError, shrinkImage, decodePng, encodePng };
