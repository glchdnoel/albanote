// 알바노트 동기화 API (Cloudflare Pages Functions)
// - Cloudflare Access 로그인 토큰을 직접 검증하고, ALLOWED_EMAIL 한 사람만 허용
// - 설정값(ACCESS_TEAM_NAME, ACCESS_AUD, ALLOWED_EMAIL, DB)이 하나라도 없으면 아무것도 하지 않음
// - 기록은 D1 데이터베이스에 저장. rev(버전 번호)가 맞을 때만 덮어써서 두 기기가 동시에 저장해도 안 꼬임
// - 하루에 한 번, 그날 첫 변경 직전 상태를 history에 보관(60일)

const MAX_BYTES = 1_500_000;
const HISTORY_DAYS = 60;
const enc = new TextEncoder(), dec = new TextDecoder();
let certCache = { team: '', at: 0, keys: null };
let tableReady = false;

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }
});

function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchCerts(team, force) {
  if (!force && certCache.team === team && certCache.keys && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs');
  const { keys } = await r.json();
  certCache = { team, at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return certCache.keys;
}

export async function verifyAccess(request, env, getCerts = fetchCerts) {
  const team = String(env.ACCESS_TEAM_NAME || '').trim();
  const aud = String(env.ACCESS_AUD || '').trim();
  const allowed = String(env.ALLOWED_EMAIL || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,63}$/.test(team) || !aud || !allowed.includes('@')) return { ok: false, status: 500 };

  const token = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401 };
  let header, payload, sig;
  try {
    header = JSON.parse(dec.decode(b64url(parts[0])));
    payload = JSON.parse(dec.decode(b64url(parts[1])));
    sig = b64url(parts[2]);
  } catch (_) { return { ok: false, status: 401 }; }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, status: 401 };

  // 키가 바뀌었을 수 있으니 못 찾으면 한 번 새로 받아옴
  let jwk = null;
  for (const force of [false, true]) {
    const keys = await getCerts(team, force);
    jwk = keys.find(k => k && k.kid === header.kid && k.kty === 'RSA');
    if (jwk) break;
  }
  if (!jwk) return { ok: false, status: 401 };
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, enc.encode(parts[0] + '.' + parts[1]));
  if (!good) return { ok: false, status: 401 };

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return { ok: false, status: 401 };
  if (!auds.includes(aud)) return { ok: false, status: 401 };
  if (typeof payload.exp !== 'number' || payload.exp + 30 < now) return { ok: false, status: 401 };
  if (typeof payload.nbf === 'number' && payload.nbf - 30 > now) return { ok: false, status: 401 };
  const email = String(payload.email || '').toLowerCase();
  if (email !== allowed) return { ok: false, status: 403 };
  return { ok: true, email };
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

async function current(db, owner) {
  const row = await db.prepare('SELECT rev, data FROM docs WHERE owner = ?').bind(owner).first();
  return row ? { rev: row.rev, data: JSON.parse(row.data) } : { rev: 0, data: null };
}

export async function onRequest(context) {
  const { request, env } = context;
  let auth;
  try { auth = await verifyAccess(request, env); } catch (_) { return json({ error: 'auth-unavailable' }, 503); }
  if (!auth.ok) return json({ error: auth.status === 500 ? 'not-configured' : 'unauthorized' }, auth.status);
  if (!env.DB) return json({ error: 'not-configured' }, 500);
  const db = env.DB;
  await ensureTables(db);

  if (request.method === 'GET') return json(await current(db, auth.email));

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
        .bind(auth.email, data, at).run();
      changes = r.meta.changes;
    } else {
      const rs = await db.batch([
        db.prepare('INSERT OR IGNORE INTO history (owner, day, rev, data) SELECT owner, ?, rev, data FROM docs WHERE owner = ? AND rev = ?')
          .bind(day, auth.email, body.rev),
        db.prepare('UPDATE docs SET rev = rev + 1, data = ?, updated = ? WHERE owner = ? AND rev = ?')
          .bind(data, at, auth.email, body.rev),
        db.prepare('DELETE FROM history WHERE owner = ? AND day < ?').bind(auth.email, cutoff)
      ]);
      changes = rs[1].meta.changes;
    }
    if (changes === 1) return json({ rev: body.rev + 1 });
    return json(await current(db, auth.email), 409); // 다른 기기가 먼저 저장함 → 최신 기록을 돌려줌
  }

  return json({ error: 'method' }, 405, { Allow: 'GET, PUT' });
}
