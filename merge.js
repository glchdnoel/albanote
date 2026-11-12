'use strict';
/* 알바노트 동기화 병합
   base   = 마지막으로 서버와 맞췄을 때의 기록
   local  = 지금 이 기기의 기록
   remote = 지금 서버의 기록
   알바·근무·추가수당·반복근무를 id별로 비교해서, 한쪽에서만 바뀐 건 그쪽을 따르고
   양쪽에서 다 고친 건 이 기기 쪽을, 한쪽은 지우고 한쪽은 고쳤으면 고친 쪽을 남김 */
(function (root) {
  const COLS = ['jobs', 'shifts', 'extras', 'repeats'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function mergeCol(base, local, remote) {
    const B = new Map(base.map(x => [x.id, x]));
    const L = new Map(local.map(x => [x.id, x]));
    const R = new Map(remote.map(x => [x.id, x]));
    const order = [...new Set([...remote.map(x => x.id), ...local.map(x => x.id)])];
    const out = [];
    for (const id of order) {
      const b = B.get(id), l = L.get(id), r = R.get(id);
      let v;
      if (!b) v = l || r;                       // 새로 생긴 것
      else {
        const lChanged = !l || !same(l, b), rChanged = !r || !same(r, b);
        if (!lChanged) v = r;                   // 이 기기는 그대로 → 서버 상태(지워졌으면 지움)
        else if (!rChanged) v = l;              // 서버는 그대로 → 이 기기 상태
        else v = l || r;                        // 둘 다 바뀜 → 이 기기 우선, 삭제보다 수정 우선
      }
      if (v) out.push(v);
    }
    return out;
  }

  function merge(base, local, remote) {
    base = base || {};
    const out = {};
    for (const c of COLS) out[c] = mergeCol(base[c] || [], local[c] || [], remote[c] || []);
    const lb = [local.lastBackup, remote.lastBackup].filter(Boolean).sort();
    out.lastBackup = lb.length ? lb[lb.length - 1] : null;
    return out;
  }

  root.AlbaMerge = { merge, same };
  if (typeof module !== 'undefined' && module.exports) module.exports = { merge, same };
})(typeof self !== 'undefined' ? self : globalThis);
