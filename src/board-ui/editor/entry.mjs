// 번들 진입점. 보드 화면은 모듈 시스템 없이 <script>로 읽으므로 전역 하나만 남긴다.
//
// 스타일은 여기서 함께 묶는다. ProseMirror의 기본 스타일과 표·간격 커서 스타일은
// 그 기능이 동작하기 위한 최소 조건이라 선택 사항이 아니다.

import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import './editor.css';

import { openEditor, schema, fromMarkdown, toMarkdown } from './index.mjs';

window.RundolEditor = { openEditor, schema, fromMarkdown, toMarkdown };
