// 실행: node tests/test_sync_api.mjs  (Node 22.5 이상, 저장소 최상위에서)
// 동기화 코드 확인과 저장 규칙을 검사하고, 맥·폰 두 기기 동기화를 흉내 냄
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { onRequest } from '../functions/api/sync.js';
const require = createRequire(import.meta.url);
const { merge, same } = require('../merge.js');

const ORIGIN = 'https://albanote.pages.dev';

// --- 가짜 D1 (실제 SQLite 사용) ---
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
  });
  return {
    raw: db,
    prepare: sql => stmt(sql),
    batch: async list => { db.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  };
}

// --- 동기화 코드 ---
const CODE = 'Abcdefghij_klmnopqrst-uvwxyz0123456789ABCDEFG'; // 테스트용 43글자
const hex = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
const HASH = await hex(CODE);

const DB = fakeD1();
const env = { SYNC_CODE_HASH: HASH.toUpperCase(), DB };
async function call(method, { auth, body, origin = ORIGIN, type = 'application/json', envOver = {} } = {}) {
  const headers = {};
  if (auth !== null) headers['Authorization'] = auth ?? `Bearer ${CODE}`;
  if (method === 'PUT') { headers['Origin'] = origin; headers['Content-Type'] = type; }
  const req = new Request(`${ORIGIN}/api/sync`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const res = await onRequest({ request: req, env: { ...env, ...envOver } });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const doc = shifts => ({ jobs: [{ id: 'j1', name: '카페', wage: 10500 }], shifts, extras: [], repeats: [], lastBackup: null });
const sh = (id, memo = '') => ({ id, jobId: 'j1', date: '2026-11-15', start: '09:00', end: '17:00', memo });

// --- 막아야 하는 것 ---
await t('코드 없음 → 401', async () => assert.equal((await call('GET', { auth: null })).status, 401));
await t('틀린 코드 → 401', async () => assert.equal((await call('GET', { auth: `Bearer ${CODE.slice(0, -1)}X` })).status, 401));
await t('해시값 자체를 코드로 보내도 → 401', async () => assert.equal((await call('GET', { auth: `Bearer ${HASH}` })).status, 401));
await t('짧은 코드·이상한 형식 → 401', async () => {
  for (const a of ['Bearer abc', `Basic ${CODE}`, `Bearer ${CODE}%`, `Bearer ${CODE} x`, CODE]) assert.equal((await call('GET', { auth: a })).status, 401, a);
});
await t('서버 등록값이 해시 형식이 아니면(코드를 그대로 넣는 실수 등) → 500', async () => {
  for (const v of [CODE, 'abc', HASH.slice(1)]) assert.equal((await call('GET', { envOver: { SYNC_CODE_HASH: v } })).status, 500, v);
});
await t('설정값 빠짐 → 500, 데이터 안 줌', async () => {
  for (const k of ['SYNC_CODE_HASH', 'DB']) {
    const r = await call('GET', { envOver: { [k]: undefined } });
    assert.equal(r.status, 500, k); assert.equal(r.body.data, undefined);
  }
});
await t('다른 사이트에서 보낸 저장 요청(Origin 다름) → 403', async () => assert.equal((await call('PUT', { body: { rev: 0, data: doc([]) }, origin: 'https://evil.com' })).status, 403));
await t('JSON이 아닌 형식 → 415', async () => assert.equal((await call('PUT', { body: '{}', type: 'text/plain' })).status, 415));
await t('형식이 틀린 기록 → 400', async () => {
  assert.equal((await call('PUT', { body: { rev: 0, data: { jobs: 'x' } } })).status, 400);
  assert.equal((await call('PUT', { body: { rev: -1, data: doc([]) } })).status, 400);
  assert.equal((await call('PUT', { body: 'not json' })).status, 400);
});
await t('너무 큰 기록 → 413', async () => assert.equal((await call('PUT', { body: { rev: 0, data: { ...doc([]), pad: 'x'.repeat(1_600_000) } } })).status, 413));
await t('허용 안 된 방법(DELETE) → 405', async () => assert.equal((await call('DELETE')).status, 405));
await t('응답은 캐시 금지', async () => assert.equal((await call('GET')).headers.get('cache-control'), 'no-store'));

// --- 정상 동작 ---
await t('처음엔 비어 있음 (rev 0)', async () => assert.deepEqual((await call('GET')).body, { rev: 0, data: null }));
await t('저장 → rev 1, 다시 받으면 같은 기록', async () => {
  assert.deepEqual((await call('PUT', { body: { rev: 0, data: doc([sh('a')]) } })).body, { rev: 1 });
  assert.deepEqual((await call('GET')).body, { rev: 1, data: doc([sh('a')]) });
});
await t('옛 버전 번호로 저장 → 409 + 최신 기록', async () => {
  const r = await call('PUT', { body: { rev: 0, data: doc([]) } });
  assert.equal(r.status, 409); assert.equal(r.body.rev, 1);
  const r2 = await call('PUT', { body: { rev: 5, data: doc([]) } });
  assert.equal(r2.status, 409); assert.deepEqual(r2.body.data, doc([sh('a')]));
});
await t('수정 전 상태가 history에 하루 1개 보관됨', async () => {
  await call('PUT', { body: { rev: 1, data: doc([sh('a'), sh('b')]) } });
  await call('PUT', { body: { rev: 2, data: doc([]) } });
  const rows = DB.raw.prepare('SELECT rev, data FROM history').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].rev, 1);
});

// --- 맥·폰 동기화 흉내 (app.js의 syncNow와 같은 순서) ---
await t('맥·폰에서 따로 고쳐도 둘 다 반영됨', async () => {
  await call('PUT', { body: { rev: 3, data: doc([sh('a')]) } });
  const dev = () => ({ S: doc([]), base: null });
  async function sync(d) {
    for (let i = 0; i < 4; i++) {
      const remote = (await call('GET')).body;
      const rdata = remote.data || doc([]);
      const m = merge(d.base && d.base.data, d.S, rdata);
      d.S = m;
      if (remote.data && same(m, rdata)) { d.base = { rev: remote.rev, data: m }; return; }
      const put = await call('PUT', { body: { rev: remote.rev, data: m } });
      if (put.status === 200) { d.base = { rev: put.body.rev, data: m }; return; }
    }
    throw new Error('sync failed');
  }
  const mac = dev(), phone = dev();
  await sync(mac); await sync(phone);
  assert.deepEqual(phone.S.shifts.map(s => s.id), ['a']);
  mac.S = doc([sh('a', '맥 메모'), sh('mac1')]);       // 맥: 수정 + 추가
  phone.S = doc([sh('a'), sh('ph1')]);                // 폰: 추가
  await sync(mac); await sync(phone); await sync(mac);
  assert.deepEqual(mac.S, phone.S);
  assert.deepEqual(phone.S.shifts.map(s => s.id).sort(), ['a', 'mac1', 'ph1']);
  assert.equal(phone.S.shifts.find(s => s.id === 'a').memo, '맥 메모');
  phone.S = doc(phone.S.shifts.filter(s => s.id !== 'mac1')); // 폰에서 삭제
  await sync(phone); await sync(mac);
  assert.deepEqual(mac.S.shifts.map(s => s.id).sort(), ['a', 'ph1']);
});
console.log(`\n${n}개 통과`);
