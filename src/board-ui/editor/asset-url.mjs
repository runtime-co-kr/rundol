// `![[이름]]`이 가리키는 그림의 주소를 만든다.
//
// 자산이 사는 자리는 프로젝트가 정하고 스냅숏이 실어 준다. 그 자리를 화면이 사본으로
// 적으면(`docs/assets`) 문서 뿌리를 옮긴 날 그림만 조용히 깨진다. 그래서 여기서는
// 자리를 짐작하지 않고 스냅숏에 묻는다.
//
// 묻지 못하면 주소를 지어내지 않고 null을 돌려준다. 지어낸 주소는 404가 되고, 그러면
// 편집기는 "자산이 없다"와 "여기가 자산 디렉터리를 모른다"를 같은 모양으로 보여 준다.
// 그 둘은 고치는 방법이 다르므로 같은 모양이면 안 된다.
//
// 이 파일이 있는 이유는 경계다. 읽기 화면(app.js)은 이미 같은 계산을 갖고 있지만 그
// 함수는 모듈 밖으로 나오지 않고, 편집기 번들은 app.js를 읽지 않는다. 밖에서
// assetUrl을 넘겨 주면 그것을 쓰고, 넘어오지 않을 때만 이 기본값이 선다.

// 프로젝트마다 한 번만 묻는다. 값은 Promise로 담아 두어 embed가 여럿일 때
// 스냅숏을 사람 수만큼 부르지 않게 한다.
const directories = new Map();

/** 지금 보고 있는 프로젝트. 주소가 정본이고, 없을 때만 화면의 고르개를 본다. */
function projectKey() {
  if (typeof location !== 'undefined' && location.hash) {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('project');
    if (fromHash) return fromHash;
  }
  if (typeof document === 'undefined') return '';
  const picker = document.getElementById('project-switcher');
  return (picker && picker.value) || '';
}

function assetsDirectory(key) {
  if (directories.has(key)) return directories.get(key);
  if (typeof fetch !== 'function') return Promise.resolve(null);
  const pending = fetch(`/api/projects/${encodeURIComponent(key)}/board-snapshot`)
    .then((response) => (response.ok ? response.json() : null))
    .then((snapshot) => (snapshot && snapshot.assets && snapshot.assets.directory) || null)
    .catch(() => null)
    .then((directory) => {
      // 못 알아낸 것은 기억하지 않는다. 한 번의 실패를 캐시에 남기면 그 편집 세션
      // 내내 모든 그림이 "자리를 모른다"로 남고, 다시 물어볼 길이 없다.
      if (!directory) directories.delete(key);
      return directory;
    });
  directories.set(key, pending);
  return pending;
}

/**
 * 자산 이름 하나를 보드가 서빙하는 주소로.
 *
 * @param {string} name `![[…]]` 안의 이름
 * @returns {Promise<string|null>} 자리를 알아내지 못하면 null
 */
export async function assetUrl(name) {
  const target = String(name || '').trim();
  if (!target) return null;
  const key = projectKey();
  if (!key) return null;
  const directory = await assetsDirectory(key);
  if (!directory) return null;
  const segments = `${directory}/${target}`.split('/').filter((part) => part && part !== '.');
  return `/api/projects/${encodeURIComponent(key)}/assets/${segments.map(encodeURIComponent).join('/')}`;
}
