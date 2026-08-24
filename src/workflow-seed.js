'use strict';

// 새 프로젝트가 받는 workflows.json. 내장과 똑같이 도는 실물을 세운다.
//
// 빈 파일을 심지 않는 이유는 board.json이 그렇게 남았기 때문이다. 다섯 칸이
// `{}`로 선언만 되어 있고 아무도 한 줄도 쓰지 않았으며, 그 사실은 아무 신호도
// 내지 않았다. 칸만 있는 파일은 "열려 있다"가 아니라 "무엇을 적는 자리인지
// 모르겠다"로 읽힌다.
//
// 전환은 넣지 않는다. 넣는 순간 새 프로젝트의 태스크가 선언한 길로만 움직이는데,
// 아직 자기 흐름을 정하지 않은 팀에게 그것은 기능이 아니라 장애물이다. 노드는
// 이름이 보이게 세워 두고, 닫는 것은 팀이 transitions를 적을 때 일어난다.
//
// 그래서 이 파일을 그대로 두면 판정이 내장과 같다. 고치기 시작하면 그때부터
// 달라지고, 무엇을 고쳤는지가 파일에 남는다.

const NODES = Object.freeze({
  todo: { step: 'unclaimed', label: '할 일' },
  doing: { step: 'in-progress', requiresOwner: true, label: '진행중' },
  waiting: { step: 'in-progress', label: '대기' },
  review: { step: 'in-approval', requiresOwner: true, label: '검토중' },
  done: { step: 'completed', validity: 'valid', requiresOwner: true, label: '완료' },
  cancelled: { step: 'dropped', requiresOwner: true, label: '취소' }
});

const DEFAULT_ID = 'task-default';

/**
 * 프로젝트가 받는 초기 정의. 워크스페이스는 받지 않는다 — 상위가 흐름을 들면
 * 하위가 그것을 물려받고, 물려받은 것을 지우려면 disabled를 적어야 한다.
 * 아무도 정하지 않은 흐름이 위에서 내려오는 것은 상속이 아니라 강요다.
 */
function renderProjectWorkflows() {
  const payload = {
    schemaVersion: 1,
    workflows: {
      [DEFAULT_ID]: {
        targetKind: 'task',
        label: '태스크 기본 흐름',
        nodes: NODES
      }
    },
    bindings: { task: { '*': DEFAULT_ID } }
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

module.exports = { DEFAULT_ID, NODES, renderProjectWorkflows };
