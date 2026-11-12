// 알바노트 동기화 API (Cloudflare Pages Functions)
// - 요청마다 "동기화 코드"를 확인. 서버에는 코드 자체가 아니라 SHA-256 값(SYNC_CODE_HASH)만 저장
//   → 설정 화면을 본 사람(AI 포함)도 코드를 알아낼 수 없음
// - 설정값(SYNC_CODE_HASH, DB)이 없거나 잘못되면 아무것도 하지 않음
// - 기록은 D1 데이터베이스에 저장. rev(버전 번호)가 맞을 때만 덮어써서 두 기기가 동시에 저장해도 안 꼬임
// - 하루에 한 번, 그날 첫 변경 직전 상태를 history에 보관(60일)

const MAX_BYTES = 1_500_000;
const HISTORY_DAYS = 60;
const OWNER = 'me';
const CODE_RX = /^[A-Za-z0-9_-]{40,100}$/;
const enc = new TextEncoder();
let tableReady = false;

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }
});

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// 글자 하나씩 다 비교 (맞은 글자 수로 시간이 달라지지 않게)
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkCode(request, env) {
  const want = String(env.SYNC_CODE_HASH || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return { ok: false, status: 500 };
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !CODE_RX.test(m[1])) return { ok: false, status: 401 };
  return sameText(await sha256hex(m[1]), want) ? { ok: true } : { ok: false, status: 401 };
}

async function ensureTables(db) {
  if (tableReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS docs (owner TEXT PRIMARY KEY, rev INTEGER NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS history (owner TEXT NOT NULL, day TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (owner, day))')
  ]);
  tableReady = true;
}

const validShape = d => d && typeof d === 'object' && !Array.isArray(d)
  && ['jobs', 'shifts'].every(k => Array.isArray(d[k]))
  && ['extras', 'repeats'].every(k => d[k] === undefined || Array.isArray(d[k]));

async function current(db) {
  const row = await db.prepare('SELECT rev, data FROM docs WHERE owner = ?').bind(OWNER).first();
  return row ? { rev: row.rev, data: JSON.parse(row.data) } : { rev: 0, data: null };
}

export async function onRequest(context) {
  const { request, env } = context;
  const auth = await checkCode(request, env);
  if (!auth.ok) return json({ error: auth.status === 500 ? 'not-configured' : 'unauthorized' }, auth.status);
  if (!env.DB) return json({ error: 'not-configured' }, 500);
  const db = env.DB;
  await ensureTables(db);

  if (request.method === 'GET') return json(await current(db));

  if (request.method === 'PUT') {
    if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: 'origin' }, 403);
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'type' }, 415);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: 'too-large' }, 413);
    const text = await request.text();
    if (enc.encode(text).length > MAX_BYTES) return json({ error: 'too-large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad-json' }, 400); }
    if (!body || !Number.isInteger(body.rev) || body.rev < 0 || !validShape(body.data)) return json({ error: 'bad-shape' }, 400);

    const data = JSON.stringify(body.data), at = new Date().toISOString(), day = at.slice(0, 10);
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
    let changes;
    if (body.rev === 0) {
      const r = await db.prepare('INSERT INTO docs (owner, rev, data, updated) VALUES (?, 1, ?, ?) ON CONFLICT(owner) DO NOTHING')
        .bind(OWNER, data, at).run();
      changes = r.meta.changes;
    } else {
      const rs = await db.batch([
        db.prepare('INSERT OR IGNORE INTO history (owner, day, rev, data) SELECT owner, ?, rev, data FROM docs WHERE owner = ? AND rev = ?')
          .bind(day, OWNER, body.rev),
        db.prepare('UPDATE docs SET rev = rev + 1, data = ?, updated = ? WHERE owner = ? AND rev = ?')
          .bind(data, at, OWNER, body.rev),
        db.prepare('DELETE FROM history WHERE owner = ? AND day < ?').bind(OWNER, cutoff)
      ]);
      changes = rs[1].meta.changes;
    }
    if (changes === 1) return json({ rev: body.rev + 1 });
    return json(await current(db), 409); // 다른 기기가 먼저 저장함 → 최신 기록을 돌려줌
  }

  return json({ error: 'method' }, 405, { Allow: 'GET, PUT' });
}
