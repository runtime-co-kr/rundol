// 플러그인의 update()가 던지지 않게 감싼다.
//
// ProseMirror는 플러그인 뷰의 update()를 updateState 안에서 부른다. 거기서 던지면
// 예외는 dispatch를 부른 쪽으로 올라가고, 그 쪽의 남은 일이 대신 죽는다. 문서는 이미
// 갱신된 뒤라 타이핑은 멀쩡해 보이므로, 죽은 것은 한참 뒤에 다른 증상으로 나타난다.
//
// 실제로 그런 일이 있었다. 툴바가 view에서 hasFocus를 구조 분해로 떼어 내 불러 this를
// 잃었고, 그 예외가 블록 손잡이의 끌기 준비를 대신 죽였다. 끌어도 아무 일이 없는 것을
// 보고 사람은 손잡이를 의심했지만 원인은 툴바에 있었다.
//
// 떠 있는 것들은 전부 화면 좌표를 읽는다. coordsAtPos와 getBoundingClientRect는
// 노드가 아직 안 그려졌거나 떼어졌을 때 던진다. 그때 할 일은 그 팝업을 감추는 것이지
// 편집을 멈추는 것이 아니다 — 자리를 못 잡은 메뉴보다 못 쓰게 된 편집기가 나쁘다.

/**
 * @param {string} name 무엇이 던졌는지 콘솔에 남길 이름
 * @param {() => void} body update의 본문
 * @param {() => void} [onFail] 던졌을 때 되돌릴 일. 보통 감추기다.
 */
export function guarded(name, body, onFail) {
  try {
    body();
  } catch (error) {
    // 조용히 삼키지 않는다. 삼키면 이 자리가 다음 결함의 숨을 곳이 된다.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[rundol-editor] ${name} update 실패:`, error);
    }
    if (onFail) {
      try { onFail(); } catch (_) { /* 감추는 것마저 실패하면 더 할 일이 없다 */ }
    }
  }
}
