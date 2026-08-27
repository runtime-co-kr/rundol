// 흐름도 번들의 진입점. 보드 화면은 모듈 시스템 없이 <script>로 읽으므로 전역 하나만 남긴다.
//
// 문서 편집기와 번들을 나눈 이유는 무게다. 흐름도는 설정 화면 한 칸에서만 쓰이는데
// 문서 편집기와 한 덩어리로 묶으면 문서를 열 때마다 그래프 라이브러리가 함께 내려온다.
//
// 스타일 파일을 함께 묶지 않는다. JointJS 4는 css를 싣지 않고 도형을 SVG 속성으로
// 그리므로 심을 스타일이 없다 — Board가 style-src 'self'로 서빙되어 svg 안에 심긴
// <style>이 통째로 막히는 것을 생각하면 그 편이 낫고, 실제로 mermaid는 그 자리에서
// 색을 잃었다.

import { mountWorkflowGraph } from './workflow.mjs';

window.RundolWorkflowGraph = { mount: mountWorkflowGraph };
