// 실행: node tests/test_sync_api.mjs  (Node 22.5 이상, 저장소 최상위에서)
// 진짜 RSA 키로 Access 토큰을 만들어 서버 함수를 검사하고, 맥·폰 두 기기 동기화를 흉내 냄
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { onRequest } from '../functions/api/sync.js';
const require = createRequire(import.meta.url);
const { merge, same } = require('../merge.js');

const TEAM = 'testteam', AUD = 'aud-123', EMAIL = 'me@example.com', ORIGIN = 'https://albanote.pages.dev';

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

// --- Access 토큰 만들기 ---
const b64u = buf => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
globalThis.fetch = async url => {
  assert.equal(String(url), `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [pub] }), { headers: { 'content-type': 'application/json' } });
};
async function token(over = {}, key = pair.privateKey, head = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', ...head }));
  const p = b64u(JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: EMAIL, exp: now + 3600, iat: now, nbf: now, ...over }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p));
  return `${h}.${p}.${b64u(sig)}`;
}

const DB = fakeD1();
const env = { ACCESS_TEAM_NAME: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: 'Me@Example.com', DB };
async function call(method, { tok, body, origin = ORIGIN, type = 'application/json', envOver = {} } = {}) {
  const headers = {};
  if (tok !== null) headers['Cf-Access-Jwt-Assertion'] = tok ?? await token();
  if (method === 'PUT') { headers['Origin'] = origin; headers['Content-Type'] = type; }
  const req = new Request(`${ORIGIN}/api/sync`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const res = await onRequest({ request: req, env: { ...env, ...envOver } });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const doc = shifts => ({ jobs: [{ id: 'j1', name: '카페', wage: 10500 }], shifts, extras: [], repeats: [], lastBackup: null });
const sh = (id, memo = '') => ({ id, jobId: 'j1', date: '2026-11-15', start: '09:00', end: '17:00', memo });

// --- 막아야 하는 것 ---
await t('토큰 없음 → 401', async () => assert.equal((await call('GET', { tok: null })).status, 401));
await t('다른 키로 서명한 토큰 → 401', async () => assert.equal((await call('GET', { tok: await token({}, other.privateKey) })).status, 401));
await t('서명 위조(내용만 바꿈) → 401', async () => {
  const [h, , s] = (await token()).split('.');
  const fake = b64u(JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: EMAIL, exp: 9e9 }));
  assert.equal((await call('GET', { tok: `${h}.${fake}.${s}` })).status, 401);
});
await t('alg none 토큰 → 401', async () => assert.equal((await call('GET', { tok: await token({}, pair.privateKey, { alg: 'none' }) })).status, 401));
await t('다른 앱용 토큰(aud 다름) → 401', async () => assert.equal((await call('GET', { tok: await token({ aud: ['other'] }) })).status, 401));
await t('다른 팀 발급(iss 다름) → 401', async () => assert.equal((await call('GET', { tok: await token({ iss: 'https://evil.cloudflareaccess.com' }) })).status, 401));
await t('만료된 토큰 → 401', async () => assert.equal((await call('GET', { tok: await token({ exp: Math.floor(Date.now() / 1000) - 120 }) })).status, 401));
await t('허용 안 된 이메일 → 403', async () => assert.equal((await call('GET', { tok: await token({ email: 'friend@example.com' }) })).status, 403));
await t('설정값 빠짐 → 500, 데이터 안 줌', async () => {
  for (const k of ['ACCESS_TEAM_NAME', 'ACCESS_AUD', 'ALLOWED_EMAIL', 'DB']) {
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
await t('다른 이메일 데이터와 섞이지 않음(이메일 대소문자 무시)', async () => {
  const rows = DB.raw.prepare('SELECT owner FROM docs').all();
  assert.deepEqual(rows.map(r => r.owner), ['me@example.com']);
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
