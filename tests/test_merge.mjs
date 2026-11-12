// 실행: node tests/test_merge.mjs  (저장소 최상위에서)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { merge } = require('../merge.js');

const job = (id, wage = 10500) => ({ id, name: id, wage });
const sh = (id, date, memo = '') => ({ id, jobId: 'j1', date, start: '09:00', end: '17:00', memo });
const doc = (shifts, jobs = [job('j1')], lastBackup = null) => ({ jobs, shifts, extras: [], repeats: [], lastBackup });
const ids = d => d.shifts.map(s => s.id).sort().join(',');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const base = doc([sh('a', '2026-11-01'), sh('b', '2026-11-02')]);

t('처음 동기화(base 없음): 양쪽 기록을 합침', () => {
  const m = merge(null, doc([sh('a', '2026-11-01')]), doc([sh('z', '2026-11-09')]));
  assert.equal(ids(m), 'a,z');
});
t('이 기기에서 추가 + 서버에서 추가 → 둘 다 남음', () => {
  const m = merge(base, doc([...base.shifts, sh('c', '2026-11-03')]), doc([...base.shifts, sh('d', '2026-11-04')]));
  assert.equal(ids(m), 'a,b,c,d');
});
t('이 기기에서 삭제, 서버는 그대로 → 삭제됨', () => {
  assert.equal(ids(merge(base, doc([base.shifts[0]]), base)), 'a');
});
t('서버(다른 기기)에서 삭제, 이 기기는 그대로 → 삭제됨', () => {
  assert.equal(ids(merge(base, base, doc([base.shifts[1]]))), 'b');
});
t('다른 기기에서 수정 → 수정 반영', () => {
  const m = merge(base, base, doc([sh('a', '2026-11-01', '폰에서 수정'), base.shifts[1]]));
  assert.equal(m.shifts.find(s => s.id === 'a').memo, '폰에서 수정');
});
t('양쪽에서 같은 근무를 수정 → 이 기기 쪽', () => {
  const m = merge(base, doc([sh('a', '2026-11-01', '맥'), base.shifts[1]]), doc([sh('a', '2026-11-01', '폰'), base.shifts[1]]));
  assert.equal(m.shifts.find(s => s.id === 'a').memo, '맥');
});
t('한쪽은 삭제, 한쪽은 수정 → 수정한 쪽이 남음', () => {
  const m1 = merge(base, doc([base.shifts[1]]), doc([sh('a', '2026-11-01', '수정'), base.shifts[1]]));
  assert.equal(m1.shifts.find(s => s.id === 'a').memo, '수정');
  const m2 = merge(base, doc([sh('a', '2026-11-01', '수정'), base.shifts[1]]), doc([base.shifts[1]]));
  assert.equal(m2.shifts.find(s => s.id === 'a').memo, '수정');
});
t('양쪽 다 삭제 → 삭제', () => {
  assert.equal(ids(merge(base, doc([base.shifts[1]]), doc([base.shifts[1]]))), 'b');
});
t('아무도 안 바꿈 → 그대로', () => {
  assert.deepEqual(merge(base, base, base), base);
});
t('알바 시급 수정도 id 단위로 합쳐짐', () => {
  const m = merge(base, base, doc(base.shifts, [job('j1', 11000)]));
  assert.equal(m.jobs[0].wage, 11000);
});
t('마지막 백업 날짜는 더 최근 것', () => {
  const m = merge(base, doc(base.shifts, undefined, '2026-11-01'), doc(base.shifts, undefined, '2026-11-10'));
  assert.equal(m.lastBackup, '2026-11-10');
});
console.log(`\n${n}개 통과`);
