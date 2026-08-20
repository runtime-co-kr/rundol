// 그림을 붙여넣거나 끌어다 놓으면 자산으로 들이고 참조를 넣는다.
//
// 지금까지 문서에 그림을 넣으려면 파일을 저장하고 `rdl asset add`를 부르고 나온
// 이름을 손으로 옮겨 적어야 했다. 세 단계 모두 사람이 하는 일이고, 마지막 단계의
// 오타는 검사에서야 드러난다.
//
// 들이는 일은 편집기가 하지 않는다. 검증과 축소는 `rdl asset add`가 이미 하고,
// 여기서 그것을 다시 하면 명령줄로 넣은 그림과 화면으로 넣은 그림이 서로 다른
// 규격을 갖는다. 편집기는 바이트를 넘기고 이름을 돌려받아 참조만 만든다.

import { Plugin, PluginKey } from 'prosemirror-state';
import { schema } from './schema.mjs';

export const imageDropKey = new PluginKey('rundol-image-drop');

function imageFiles(list) {
  return Array.from(list || []).filter((file) => file && /^image\//u.test(file.type));
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('그림을 읽지 못했습니다.'));
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      resolve(comma < 0 ? value : value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * @param {{upload?: (input: {name: string, data: string}) => Promise<{name: string}>,
 *          onMessage?: (text: string, bad?: boolean) => void}} options
 *   upload는 밖에서 받는다. 편집기가 저장소에 쓰면 브라우저에서 돌 수 없다.
 */
export function imageDrop(options = {}) {
  const upload = options.upload;
  const say = options.onMessage || (() => {});

  async function insert(view, files, at) {
    if (!upload) {
      say('이 화면에서는 그림을 넣을 수 없습니다. rdl asset add로 넣으세요.', true);
      return;
    }
    for (const file of files) {
      try {
        say(`${file.name || '그림'}을 들이는 중입니다…`);
        const data = await readAsBase64(file);
        const added = await upload({ name: file.name || 'image.png', data });
        const node = schema.nodes.wiki_link.create({ target: added.name, alias: null, embed: true });
        // 넣을 자리는 시작할 때 정한 곳이다. 업로드가 도는 사이 커서가 움직였을 수
        // 있는데, 사람이 놓은 자리와 다른 곳에 그림이 들어가면 그것을 다시 찾아야 한다.
        const pos = Math.min(at == null ? view.state.selection.from : at, view.state.doc.content.size);
        view.dispatch(view.state.tr.insert(pos, node).scrollIntoView());
        say(added.hint ? `${added.name}을 넣었습니다. ${added.hint}` : `${added.name}을 넣었습니다.`);
      } catch (error) {
        say(`그림을 넣지 못했습니다: ${error.message}`, true);
      }
    }
    view.focus();
  }

  return new Plugin({
    key: imageDropKey,
    props: {
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData && event.clipboardData.files);
        if (!files.length) return false;
        event.preventDefault();
        insert(view, files, view.state.selection.from);
        return true;
      },
      handleDrop(view, event) {
        const files = imageFiles(event.dataTransfer && event.dataTransfer.files);
        if (!files.length) return false;
        event.preventDefault();
        const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
        insert(view, files, found ? found.pos : view.state.selection.from);
        return true;
      }
    }
  });
}

/** 파일 고르기 창을 열어 같은 경로로 넣는다. 메뉴에서 부른다. */
export function pickImage(view, options = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
  input.multiple = true;
  input.style.display = 'none';
  document.body.append(input);
  input.addEventListener('change', () => {
    const files = imageFiles(input.files);
    input.remove();
    if (!files.length) return;
    const plugin = imageDropKey.get(view.state);
    if (!plugin) return;
    // 붙여넣기와 같은 경로를 타야 규격이 같다. 이벤트를 흉내 내 그 처리를 부른다.
    plugin.props.handlePaste(view, { clipboardData: { files }, preventDefault() {} });
  });
  input.click();
}
