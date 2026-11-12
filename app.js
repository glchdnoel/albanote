'use strict';
/* 알바노트 — 외부 라이브러리 없이 동작하는 개인용 알바 급여 웹앱 */

/* ---------- 기본 설정 ---------- */
const KEY = 'albanote.v1';
const PALETTE = ['#2F7D5B', '#C2573A', '#3B6EA8', '#9A6BB8', '#C9952B', '#4A9A9A', '#B5476E', '#6B7A3A'];
// 4대보험 근로자 부담률(%). 연도가 바뀌면 여기에 한 줄 추가. ltc = 건강보험료 대비 장기요양 비율
const RATE_TABLE = [
  { from: '2027-01', pension: 5.0, health: 3.595, ltc: 13.90, emp: 0.9, note: '고용보험은 2027년 요율 발표 전이라 2026년 값 사용' },
  { from: '2026-01', pension: 4.75, health: 3.595, ltc: 13.14, emp: 0.9 }
];
const ratesFor = month => RATE_TABLE.find(r => month >= r.from) || RATE_TABLE[RATE_TABLE.length - 1];
const MIN_WAGE = [{ from: '2027-01-01', wage: 10700 }, { from: '2026-01-01', wage: 10320 }];
const DED_LABEL = { none: '공제 없음', '33': '3.3%', ins: '4대보험' };
const BACKUP_REMIND_DAYS = 14;

/* ---------- 유틸 ---------- */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const ov = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
const short = n => { n = Math.round(n); if (n >= 10000) { const v = n / 10000; return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + '만'; } return n.toLocaleString('ko-KR'); };
const fmtH = min => { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return m ? `${h}시간 ${m}분` : `${h}시간`; };
const esc = s => String(s ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const minWage = date => (MIN_WAGE.find(w => date >= w.from) || MIN_WAGE[MIN_WAGE.length - 1]).wage;
const t10 = x => Math.floor(x / 10) * 10; // 10원 미만 절사

/* ---------- 데이터 검증 (저장된 값·가져온 파일 모두 이걸 통과해야 화면에 쓰임) ---------- */
const RX = { hex: /^#[0-9a-fA-F]{6}$/, date: /^\d{4}-\d{2}-\d{2}$/, time: /^([01]\d|2[0-3]):[0-5]\d$/, month: /^\d{4}-\d{2}$/, id: /^[A-Za-z0-9_-]{1,40}$/ };
const num = (v, def = 0, lo = 0, hi = 1e9) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const str = (v, max) => String(v ?? '').slice(0, max);
function clean(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.jobs) || !Array.isArray(d.shifts)) throw new Error('형식이 맞지 않아요');
  const jobs = d.jobs.filter(j => j && RX.id.test(j.id)).slice(0, 50).map((j, i) => ({
    id: j.id, name: str(j.name, 30) || '알바', color: RX.hex.test(j.color) ? j.color : PALETTE[i % PALETTE.length],
    wage: num(j.wage, 0, 0, 1e6), payday: Math.round(num(j.payday, 10, 1, 31)), payNext: !!j.payNext,
    size5: !!j.size5, juhyu: j.juhyu !== false, deduct: ['none', '33', 'ins'].includes(j.deduct) ? j.deduct : 'none',
    breakMin: Math.round(num(j.breakMin, 0, 0, 1440)),
    defStart: RX.time.test(j.defStart) ? j.defStart : '09:00', defEnd: RX.time.test(j.defEnd) ? j.defEnd : '18:00'
  }));
  const ids = new Set(jobs.map(j => j.id));
  const shifts = d.shifts.filter(s => s && RX.id.test(s.id) && ids.has(s.jobId) && RX.date.test(s.date) && RX.time.test(s.start) && RX.time.test(s.end))
    .slice(0, 20000).map(s => ({
      id: s.id, jobId: s.jobId, date: s.date, start: s.start, end: s.end, breakMin: Math.round(num(s.breakMin, 0, 0, 1440)),
      holiday: !!s.holiday, absent: !!s.absent, memo: str(s.memo, 200)
    }));
  const extras = (Array.isArray(d.extras) ? d.extras : []).filter(x => x && RX.id.test(x.id) && ids.has(x.jobId) && RX.month.test(x.month))
    .slice(0, 5000).map(x => ({ id: x.id, jobId: x.jobId, month: x.month, kind: x.kind === 'minus' ? 'minus' : 'plus', label: str(x.label, 30) || '기타', amount: Math.round(num(x.amount, 0, 0, 1e9)) }));
  const repeats = (Array.isArray(d.repeats) ? d.repeats : []).filter(r => r && RX.id.test(r.id) && ids.has(r.jobId) && RX.date.test(r.from)
    && RX.time.test(r.start) && RX.time.test(r.end) && (r.until == null || RX.date.test(r.until))).slice(0, 500).map(r => ({
      id: r.id, jobId: r.jobId, from: r.from, until: r.until || null, start: r.start, end: r.end,
      breakMin: Math.round(num(r.breakMin, 0, 0, 1440)), holiday: !!r.holiday,
      skip: (Array.isArray(r.skip) ? r.skip : []).filter(x => RX.date.test(x)).slice(0, 2000)
    }));
  return { jobs, shifts, extras, repeats, lastBackup: RX.date.test(d.lastBackup) ? d.lastBackup : null };
}
const emptyData = () => ({ jobs: [], shifts: [], extras: [], repeats: [], lastBackup: null });

/* ---------- 저장소 ---------- */
let storageOK = true;
function load() {
  try {
    localStorage.setItem('__t', '1'); localStorage.removeItem('__t');
    const raw = localStorage.getItem(KEY); if (!raw) return null;
    return clean(JSON.parse(raw));
  } catch (e) { if (e instanceof DOMException) storageOK = false; return null; }
}
let S = load() || emptyData();
function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { storageOK = false; renderBanner(); } }
function save() { saveLocal(); scheduleSync(); }

/* ---------- 기기 간 동기화 (albanote.pages.dev에서만, 동기화 코드를 넣은 기기만) ---------- */
const SYNC_ON = location.hostname === 'albanote.pages.dev';
const BASE_KEY = 'albanote.base.v1'; // 마지막으로 서버와 맞춘 상태 {rev, data}
const CODE_KEY = 'albanote.synccode.v1'; // 이 기기에만 저장. 서버에는 코드의 해시값만 있음
const CODE_RX = /^[A-Za-z0-9_-]{40,100}$/;
function getCode() { try { const c = localStorage.getItem(CODE_KEY); return c && CODE_RX.test(c) ? c : null; } catch (_) { return null; } }
function setCode(c) { try { if (c) localStorage.setItem(CODE_KEY, c); else localStorage.removeItem(CODE_KEY); } catch (_) {} }
const SYNC = { state: SYNC_ON ? (getCode() ? 'wait' : 'nocode') : 'off', at: null, busy: false, again: false, timer: null, pendingRender: false };
function loadBase() {
  try { const b = JSON.parse(localStorage.getItem(BASE_KEY)); if (b && Number.isInteger(b.rev) && b.rev >= 0) return { rev: b.rev, data: clean(b.data) }; } catch (_) {}
  return null;
}
function saveBase(b) { try { localStorage.setItem(BASE_KEY, JSON.stringify(b)); } catch (_) {} }
function scheduleSync(ms = 1500) {
  if (!SYNC_ON) return;
  clearTimeout(SYNC.timer); SYNC.timer = setTimeout(syncNow, ms);
}
async function syncApi(method, body) {
  const code = getCode(); if (!code) throw new Error('nocode');
  const headers = { Authorization: 'Bearer ' + code };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api/sync', { method, cache: 'no-store', credentials: 'omit', headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) throw new Error('badcode');
  if ((res.status !== 200 && res.status !== 409) || !(res.headers.get('content-type') || '').includes('application/json')) throw new Error('server');
  return { status: res.status, body: await res.json() };
}
function setSync(state) {
  const was = SYNC.state; SYNC.state = state; if (state === 'ok') SYNC.at = new Date();
  if (was !== state || view.tab === 'set') { if ($('#overlay').classList.contains('open')) SYNC.pendingRender = true; else render(); }
}
async function syncNow() {
  if (!SYNC_ON) return;
  if (SYNC.busy) { SYNC.again = true; return; }
  if (!getCode()) { setSync('nocode'); return; }
  if (!navigator.onLine) { setSync('offline'); return; }
  SYNC.busy = true; SYNC.again = false;
  try {
    for (let tries = 0; tries < 4; tries++) {
      const remote = (await syncApi('GET')).body;
      const rdata = remote.data ? clean(remote.data) : emptyData();
      const base = loadBase();
      const merged = clean(AlbaMerge.merge(base && base.data, clean(S), rdata));
      if (!AlbaMerge.same(merged, S)) {
        S = merged; saveLocal();
        if ($('#overlay').classList.contains('open')) SYNC.pendingRender = true; else render();
      }
      if (remote.data && AlbaMerge.same(merged, rdata)) { saveBase({ rev: remote.rev, data: merged }); break; }
      const put = await syncApi('PUT', { rev: remote.rev, data: merged });
      if (put.status === 200) { saveBase({ rev: put.body.rev, data: merged }); break; }
      // 409: 그 사이 다른 기기가 저장함 → 다시 받아서 합치기
    }
    setSync('ok');
  } catch (e) {
    setSync(['nocode', 'badcode'].includes(e.message) ? e.message : navigator.onLine ? 'error' : 'offline');
  } finally {
    SYNC.busy = false;
    if (SYNC.again) scheduleSync(300);
  }
}
const SYNC_TEXT = {
  off: '이 주소에서는 동기화를 쓰지 않아요. albanote.pages.dev에서 열어주세요.',
  wait: '동기화 준비 중이에요.',
  ok: '맥북·폰과 동기화됐어요.',
  offline: '인터넷이 끊겨 있어요. 기록은 이 기기에 저장되고, 연결되면 자동으로 맞춰요.',
  nocode: '이 기기에는 아직 동기화 코드가 없어요. 아래에 코드를 넣어 주세요. 처음이라면 새 코드를 만들면 돼요.',
  badcode: '동기화 코드가 맞지 않아요. 코드를 다시 넣어 주세요. (서버에 등록한 코드가 바뀌었을 수 있어요)',
  error: '서버와 연결이 안 돼요. 기록은 이 기기에 저장되고, 잠시 뒤 다시 시도해요.'
};
// 브라우저가 저장공간을 임의로 지우지 않도록 요청
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}

const now = new Date();
const view = { y: now.getFullYear(), m: now.getMonth(), tab: 'cal' };
const jobById = id => S.jobs.find(j => j.id === id);
const addDays = (ds, n) => { const d = parseYMD(ds); return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };
const WK = '일월화수목금토';
const digits = v => Number(String(v ?? '').replace(/[^0-9]/g, '')) || 0;

/* ---------- 반복 근무 ---------- */
// 반복 규칙 하나를 a~b 날짜 사이의 실제 근무들로 펼침 (매주 같은 요일)
function occurrences(rule, a, b) {
  const out = [], lo = rule.from > a ? rule.from : a, hi = rule.until && rule.until < b ? rule.until : b;
  if (lo > hi) return out;
  const diff = Math.round((parseYMD(lo) - parseYMD(rule.from)) / 864e5);
  for (let ds = addDays(lo, (7 - diff % 7) % 7); ds <= hi; ds = addDays(ds, 7)) {
    if (rule.skip.includes(ds)) continue;
    out.push({ id: `r~${rule.id}~${ds}`, ruleId: rule.id, jobId: rule.jobId, date: ds, start: rule.start, end: rule.end,
      breakMin: rule.breakMin, holiday: rule.holiday, absent: false, memo: '' });
  }
  return out;
}
// 직접 입력한 근무 + 반복 근무
function shiftsBetween(a, b) {
  return S.shifts.filter(s => s.date >= a && s.date <= b).concat(...S.repeats.map(r => occurrences(r, a, b)));
}
function findShift(id) {
  if (!id.startsWith('r~')) return S.shifts.find(s => s.id === id);
  const [, rid, ds] = id.split('~'), rule = S.repeats.find(r => r.id === rid);
  return rule ? occurrences(rule, ds, ds)[0] : null;
}

/* ---------- 계산 ---------- */
// 근무 1건: 근무시간·야간시간·기본급·가산수당
function calcShift(s, job) {
  const st = toMin(s.start); let en = toMin(s.end); if (en <= st) en += 1440; // 자정 넘김
  const total = en - st;
  const brk = Math.min(Number(s.breakMin) || 0, total);
  const work = total - brk;
  const nightRaw = ov(st, en, 0, 360) + ov(st, en, 1320, 1800) + ov(st, en, 2760, 2880); // 22:00~06:00
  const nightMin = total ? nightRaw * work / total : 0; // 휴게시간은 비율로 차감
  const w = Number(job.wage) || 0;
  const r = { total, work, nightMin, base: 0, nightPay: 0, otPay: 0, holPay: 0, pay: 0 };
  if (s.absent) return r;
  r.base = work / 60 * w;
  if (job.size5) { // 가산수당은 5인 이상 사업장만
    r.nightPay = nightMin / 60 * w * 0.5;
    if (s.holiday) r.holPay = (Math.min(work, 480) * 0.5 + Math.max(0, work - 480) * 1.0) / 60 * w;
    else r.otPay = Math.max(0, work - 480) / 60 * w * 0.5; // 하루 8시간 초과
  }
  r.pay = r.base + r.nightPay + r.otPay + r.holPay;
  return r;
}
// 그 달에 일요일이 속한 주(월~일)의 월요일 목록
function weeksEndingInMonth(y, m) {
  const res = [], last = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= last; d++) if (new Date(y, m, d).getDay() === 0) res.push(new Date(y, m, d - 6));
  return res;
}
// 주휴수당: 주 15시간 이상 + 결근 없음 → (주 근로시간, 최대 40) ÷ 40 × 8 × 시급
function juhyuForWeek(job, mon) {
  const days = []; for (let i = 0; i < 7; i++) days.push(ymd(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)));
  const ss = shiftsBetween(days[0], days[6]).filter(s => s.jobId === job.id);
  if (!ss.length) return null;
  let min = 0, absent = false;
  ss.forEach(s => { if (s.absent) absent = true; else min += calcShift(s, job).work; });
  const hours = min / 60;
  let pay = 0, reason = '지급';
  if (!job.juhyu) reason = '미적용';
  else if (absent) reason = '결근 있음';
  else if (hours < 15) reason = '15시간 미만';
  else pay = Math.min(hours, 40) / 40 * 8 * job.wage;
  return { mon: days[0], sun: days[6], hours, pay, reason };
}
function deduct(gross, type, month) {
  const r = ratesFor(month);
  if (type === '33') {
    const tax = t10(gross * 0.03), loc = t10(tax * 0.1);
    return { items: [['소득세 3%', tax], ['지방소득세 0.3%', loc]], sum: tax + loc };
  }
  if (type === 'ins') {
    const p = t10(gross * r.pension / 100), h = t10(gross * r.health / 100), l = t10(h * r.ltc / 100), e = t10(gross * r.emp / 100);
    return { items: [[`국민연금 (${r.pension}%)`, p], [`건강보험 (${r.health}%)`, h], [`장기요양보험 (건강보험료의 ${r.ltc}%)`, l], [`고용보험 (${r.emp}%)`, e]], sum: p + h + l + e };
  }
  return { items: [], sum: 0 };
}
function monthJob(job, y, m) {
  const mk = `${y}-${pad(m + 1)}`;
  const ss = shiftsBetween(mk + '-01', mk + '-31').filter(s => s.jobId === job.id);
  const r = { work: 0, base: 0, night: 0, ot: 0, hol: 0, absentDays: 0, dates: new Set(), belowMin: false };
  ss.forEach(s => {
    if (s.absent) { r.absentDays++; return; }
    const c = calcShift(s, job);
    r.dates.add(s.date); r.work += c.work; r.base += c.base; r.night += c.nightPay; r.ot += c.otPay; r.hol += c.holPay;
    if (job.wage < minWage(s.date)) r.belowMin = true;
  });
  r.weeks = weeksEndingInMonth(y, m).map(mon => juhyuForWeek(job, mon)).filter(Boolean);
  r.juhyu = r.weeks.reduce((a, w) => a + w.pay, 0);
  r.extras = S.extras.filter(x => x.jobId === job.id && x.month === mk);
  r.plus = r.extras.filter(x => x.kind === 'plus').reduce((a, x) => a + x.amount, 0);   // 상여·수당 → 세전에 포함
  r.minus = r.extras.filter(x => x.kind === 'minus').reduce((a, x) => a + x.amount, 0); // 가불 등 → 실수령에서 차감
  r.gross = Math.round(r.base + r.night + r.ot + r.hol + r.juhyu + r.plus);
  r.ded = deduct(r.gross, job.deduct, mk);
  r.net = r.gross - r.ded.sum - r.minus;
  return r;
}
function monthAll(y, m) {
  const per = S.jobs.map(j => ({ job: j, r: monthJob(j, y, m) }));
  const dates = new Set(); per.forEach(p => p.r.dates.forEach(d => dates.add(d)));
  const sum = k => per.reduce((a, p) => a + (k === 'ded' ? p.r.ded.sum : p.r[k]), 0);
  return { per, days: dates.size, work: sum('work'), gross: sum('gross'), ded: sum('ded'), minus: sum('minus'), net: sum('net') };
}
// 급여일: 익월 지급이면 지난달 급여, 아니면 이번 달 급여
function paydaysInMonth(y, m) {
  const res = {}, last = new Date(y, m + 1, 0).getDate();
  S.jobs.forEach(j => {
    const ds = `${y}-${pad(m + 1)}-${pad(Math.min(j.payday, last))}`;
    const src = j.payNext ? new Date(y, m - 1, 1) : new Date(y, m, 1);
    const r = monthJob(j, src.getFullYear(), src.getMonth());
    (res[ds] = res[ds] || []).push({ job: j, month: src.getMonth() + 1, net: r.net });
  });
  return res;
}

/* ---------- 화면 ---------- */
const ICON = {
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="3"/><circle cx="12" cy="12.5" r="2.5"/><path d="M7 3h10"/></svg>',
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="13" rx="3"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/></svg>',
  set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>'
};
function render() {
  renderBanner(); renderHead();
  $('#tabs').innerHTML = [['cal', '달력'], ['pay', '급여'], ['jobs', '알바'], ['set', '설정']]
    .map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${view.tab === k ? 'on' : ''}">${ICON[k]}${l}</button>`).join('');
  $('#fab').style.display = (view.tab === 'cal' && S.jobs.length) ? '' : 'none';
  const main = $('#main');
  if (view.tab === 'cal') main.innerHTML = renderCal();
  else if (view.tab === 'pay') main.innerHTML = renderPay();
  else if (view.tab === 'jobs') main.innerHTML = renderJobs();
  else main.innerHTML = renderSettings();
}
function renderBanner() {
  let h = '';
  if (!storageOK) h = '<div class="warn">이 브라우저에서는 데이터 저장이 막혀 있어요. 창을 닫으면 입력한 내용이 사라지니, 설정 › 기록 보관하기에서 저장해 두세요.</div>';
  else if (SYNC.state === 'badcode') h = `<div class="warn">${SYNC_TEXT.badcode} 설정 › 기기 간 동기화</div>`;
  else if (S.shifts.length || S.repeats.length) {
    const days = S.lastBackup ? (now - parseYMD(S.lastBackup)) / 864e5 : Infinity;
    if (days > BACKUP_REMIND_DAYS) h = `<div class="warn">${S.lastBackup ? `마지막 백업이 ${Math.floor(days)}일 전이에요.` : '아직 백업한 적이 없어요.'} 설정 › 기록 보관하기에서 파일로 저장해 두세요.</div>`;
  }
  $('#banner').innerHTML = h;
}
function renderHead() {
  if (view.tab === 'jobs' || view.tab === 'set') {
    $('#head').innerHTML = `<div class="mnav"><h1>${view.tab === 'jobs' ? '내 알바' : '설정'}</h1></div>`; return;
  }
  const t = monthAll(view.y, view.m);
  const isNow = view.y === now.getFullYear() && view.m === now.getMonth();
  $('#head').innerHTML = `
  <div class="mnav">
    <button class="nb" data-act="prev" aria-label="이전 달">‹</button>
    <div class="mid"><h1>${view.y}년 ${view.m + 1}월</h1>${isNow ? '' : '<button class="today-btn" data-act="thisMonth">오늘</button>'}</div>
    <button class="nb" data-act="next" aria-label="다음 달">›</button>
  </div>
  <div class="sum">
    <small>${view.m + 1}월 예상 실수령</small>
    <b class="big">${won(t.net)}</b>
    <div class="sub"><span>세전 ${won(t.gross)}</span><span>${fmtH(t.work)} · ${t.days}일</span></div>
  </div>`;
}
function renderCal() {
  if (!S.jobs.length) return emptyJobs();
  const { y, m } = view, first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate(), today = ymd(now);
  const juhyuBySun = {};
  weeksEndingInMonth(y, m).forEach(mon => S.jobs.forEach(j => {
    const w = juhyuForWeek(j, mon); if (w && w.pay > 0) juhyuBySun[w.sun] = (juhyuBySun[w.sun] || 0) + w.pay;
  }));
  const paydays = paydaysInMonth(y, m);
  const monthShifts = shiftsBetween(`${y}-${pad(m + 1)}-01`, `${y}-${pad(m + 1)}-${pad(last)}`);
  let h = '<div class="dow">' + ['일', '월', '화', '수', '목', '금', '토'].map((d, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</span>`).join('') + '</div><div class="grid">';
  for (let i = 0; i < first; i++) h += '<div class="cell empty"></div>';
  for (let d = 1; d <= last; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`, dow = (first + d - 1) % 7, future = ds > today;
    const ss = monthShifts.filter(s => s.date === ds && jobById(s.jobId)).sort((a, b) => a.start.localeCompare(b.start));
    let chips = ss.slice(0, 3).map(s => {
      const j = jobById(s.jobId), c = calcShift(s, j);
      return `<div class="chip ${future ? 'plan' : ''} ${s.absent ? 'abs' : ''}" style="--c:${j.color}">${s.absent ? '결근' : short(c.pay)}</div>`;
    }).join('');
    if (ss.length > 3) chips += `<div class="more">+${ss.length - 3}</div>`;
    if (juhyuBySun[ds]) chips += `<div class="jh">주휴<br>+${short(juhyuBySun[ds])}</div>`;
    h += `<button class="cell ${ds === today ? 'today' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}" data-act="day" data-date="${ds}">
      <span class="dn">${d}${paydays[ds] ? '<span class="pd">💰</span>' : ''}</span>${chips}</button>`;
  }
  h += '</div><div class="legend">' + S.jobs.map(j => `<span><i style="background:${j.color}"></i>${esc(j.name)}</span>`).join('') +
    '<span><i class="dash"></i>예정</span><span>💰 급여일</span></div>';
  return h;
}
function renderPay() {
  if (!S.jobs.length) return emptyJobs();
  const t = monthAll(view.y, view.m);
  let h = '';
  t.per.forEach(({ job: j, r }) => {
    const rows = [];
    rows.push(['근무', `${r.dates.size}일 · ${fmtH(r.work)}`]);
    rows.push([`기본급 (시급 ${j.wage.toLocaleString()}원)`, won(r.base)]);
    if (j.size5) { rows.push(['야간수당 (22~06시 +50%)', won(r.night)]); rows.push(['연장수당 (8시간 초과 +50%)', won(r.ot)]); rows.push(['휴일수당', won(r.hol)]); }
    rows.push(['주휴수당', won(r.juhyu)]);
    const xp = r.extras.filter(x => x.kind === 'plus'), xm = r.extras.filter(x => x.kind === 'minus');
    const xrow = x => `<div class="xitem"><span class="nm">${esc(x.label)}</span><span class="${x.kind === 'plus' ? 'plus' : 'minus-t'}">${x.kind === 'plus' ? '+' : '−'}${won(x.amount)}</span><button class="x" data-act="delExtra" data-id="${esc(x.id)}" aria-label="삭제">×</button></div>`;
    h += `<div class="card">
      <div class="ch"><span class="dot" style="background:${j.color}"></span><b>${esc(j.name)}</b><span class="tag">${DED_LABEL[j.deduct]}</span><span class="tag">${j.size5 ? '5인 이상' : '5인 미만'}</span></div>
      <div class="rows">
        ${rows.map(([a, b]) => `<div class="r"><span>${a}</span><span>${b}</span></div>`).join('')}
        ${xp.map(xrow).join('')}
        <div class="r sep tot"><span>세전 합계</span><span>${won(r.gross)}</span></div>
        ${r.ded.items.map(([a, b]) => `<div class="r minus"><span>${a}</span><span>−${won(b)}</span></div>`).join('')}
        ${xm.map(xrow).join('')}
        <div class="r sep net"><span>실수령</span><span>${won(r.net)}</span></div>
      </div>
      <button class="small-btn addx" data-act="newExtra" data-id="${esc(j.id)}">+ 상여·가불 등 기타 내역</button>
      ${!j.size5 ? '<div class="note">5인 미만 사업장은 야간·연장·휴일 가산수당이 없어요 (주휴수당은 적용).</div>' : ''}
      ${j.deduct === 'ins' ? '<div class="note">근로소득세(간이세액표)는 포함하지 않았어요.</div>' : ''}
      ${r.belowMin ? '<div class="warn">시급이 최저임금보다 낮아요 (2026년 10,320원 · 2027년 10,700원).</div>' : ''}
      ${r.absentDays ? `<div class="note">결근 ${r.absentDays}일</div>` : ''}
      ${r.weeks.length ? `<details><summary>주휴수당 주별 계산</summary><table>
        <tr><th>주 (월~일)</th><th>근무</th><th>주휴</th><th>판정</th></tr>
        ${r.weeks.map(w => `<tr><td>${w.mon.slice(5).replace('-', '/')}~${w.sun.slice(5).replace('-', '/')}</td><td>${Math.round(w.hours * 10) / 10}h</td><td>${won(w.pay)}</td><td>${w.reason}</td></tr>`).join('')}
      </table><div class="note">주는 월~일 기준이고, 일요일이 속한 달에 넣어 계산해요.</div></details>` : ''}
    </div>`;
  });
  if (t.per.length > 1) h += `<div class="card"><div class="ch"><b>${view.m + 1}월 합계</b></div><div class="rows">
    <div class="r"><span>세전</span><span>${won(t.gross)}</span></div>
    <div class="r minus"><span>공제</span><span>−${won(t.ded)}</span></div>
    ${t.minus ? `<div class="r minus"><span>가불 등</span><span>−${won(t.minus)}</span></div>` : ''}
    <div class="r sep net"><span>실수령</span><span>${won(t.net)}</span></div></div></div>`;
  return h;
}
function renderJobs() {
  let h = '<div class="joblist">';
  if (!S.jobs.length) h += '<div class="empty-state"><b>등록된 알바가 없어요</b>알바를 추가하면 달력에 근무를 넣을 수 있어요.</div>';
  S.jobs.forEach(j => {
    h += `<div class="card"><span class="dot" style="background:${j.color};width:14px;height:14px"></span>
      <div class="meta"><b>${esc(j.name)}</b><small>시급 ${j.wage.toLocaleString()}원 · ${j.size5 ? '5인 이상' : '5인 미만'} · ${DED_LABEL[j.deduct]} · ${j.payNext ? '익월' : '당월'} ${j.payday}일 지급</small></div>
      <button class="small-btn" data-act="editJob" data-id="${esc(j.id)}">수정</button></div>`;
  });
  h += '</div><button class="primary block" data-act="newJob">+ 알바 추가</button>';
  const rules = S.repeats.filter(r => jobById(r.jobId)).sort((a, b) => a.from.localeCompare(b.from));
  if (rules.length) {
    const today = ymd(now);
    h += '<div class="sec-title">반복 근무</div>';
    rules.forEach(r => {
      const j = jobById(r.jobId), ended = r.until && r.until < today;
      h += `<div class="card rule ${ended ? 'ended' : ''}"><span class="dot" style="background:${j.color}"></span>
        <div class="meta"><b>${esc(j.name)} · 매주 ${WK[parseYMD(r.from).getDay()]}요일 ${r.start}~${r.end}</b>
        <small>${r.from.replace(/-/g, '.')}부터 · ${r.until ? `${r.until.replace(/-/g, '.')}까지${ended ? ' (끝남)' : ''}` : '끝나는 날 없이 계속'}</small></div>
        <button class="small-btn" data-act="ruleEnd" data-id="${esc(r.id)}">${r.until ? '종료일 변경' : '끝내기'}</button></div>`;
    });
  }
  return h;
}
function syncControls() {
  if (SYNC.state === 'nocode' || SYNC.state === 'badcode') return `
    <label class="f"><input id="syncCode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="동기화 코드 붙여넣기"></label>
    <button class="primary block" data-act="saveCode">코드 저장하고 동기화</button>
    <button class="ghost block" style="margin-top:8px" data-act="newCode">새 코드 만들기 (처음 한 번만)</button>`;
  return `<button class="ghost block" data-act="syncNow">지금 동기화</button>
    <button class="ghost block" style="margin-top:8px" data-act="forgetCode">이 기기에서 코드 지우기</button>`;
}
// 동기화 코드: 32바이트 무작위 → 43글자. 이 브라우저 안에서만 만들어지고 서버·AI에는 해시값만 감
let pendingCode = null;
async function makeCode() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  const code = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return { code, hash: [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('') };
}
function renderSettings() {
  const rate = (r, y) => `<div class="r"><span>${y}년</span><span>국민연금 ${r.pension}% · 건강 ${r.health}% · 고용 ${r.emp}%</span></div>`;
  return `
  <div class="sec-title">기기 간 동기화</div>
  <div class="card">
    <div class="note" style="margin:0 0 10px;font-size:13.5px;color:var(--ink)">${esc(SYNC_TEXT[SYNC.state])}${SYNC.state === 'ok' && SYNC.at ? ` <span style="color:var(--muted)">(${pad(SYNC.at.getHours())}:${pad(SYNC.at.getMinutes())})</span>` : ''}</div>
    ${SYNC_ON ? syncControls() : ''}
  </div>
  <div class="sec-title">기록 보관하기</div>
  <div class="card">
    <div class="note" style="margin:0 0 12px;font-size:13.5px;color:var(--ink)">
      ${SYNC_ON ? '기록은 이 기기와 동기화 서버에 저장돼요. 혹시 모를 실수에 대비해' : '입력한 알바·근무 기록은 <b>이 기기 안에만</b> 저장돼요. 기기를 바꾸거나 Safari 기록을 지우면 사라질 수 있으니'}
      가끔 <b>기록 파일로 저장하기</b>를 눌러 카카오톡 나와의 채팅이나 메일로 보관해 두면, 나중에 <b>저장한 파일로 되살리기</b>로 그대로 복구할 수 있어요.
    </div>
    <button class="primary block" data-act="exportFile">기록 파일로 저장하기</button>
    <button class="ghost block" style="margin-top:8px" data-act="importFile">저장한 파일로 되살리기</button>
    <div class="note">${S.lastBackup ? `마지막 저장: ${S.lastBackup.replace(/-/g, '.')}` : '아직 저장한 적 없어요'}</div>
    <details><summary>파일 저장이 안 될 때 (글자로 복사해 두기)</summary>
      <div class="note">아래 글자를 통째로 복사해 메모 앱에 붙여넣어 두면 돼요. 되살릴 때는 그 글자를 여기에 붙여넣고 '붙여넣은 기록 되살리기'를 누르세요.</div>
      <label class="f" style="margin-top:8px"><textarea id="bk">${esc(JSON.stringify(S))}</textarea></label>
      <div class="btns" style="margin-top:0"><button class="ghost" data-act="copyBk">복사</button><button class="ghost" data-act="importBk">붙여넣은 기록 되살리기</button></div>
    </details>
  </div>
  <div class="sec-title">세금·4대보험</div>
  <div class="card">
    <div class="note" style="margin:0 0 6px;font-size:13.5px;color:var(--ink)">따로 설정할 건 없어요. 알바마다 '떼는 돈'만 고르면, 해마다 바뀌는 비율은 앱이 알아서 적용해요.</div>
    <details><summary>적용 중인 4대보험 비율 보기</summary>
      <div class="rows" style="margin-top:6px">${RATE_TABLE.map(r => rate(r, r.from.slice(0, 4))).join('')}</div>
      <div class="note">장기요양보험은 건강보험료에 비율을 곱해요 (2026년 13.14%, 2027년 13.90%). 2027년 고용보험은 아직 발표 전이라 2026년 값으로 계산해요.</div>
    </details>
  </div>
  <div class="sec-title">처음부터 다시</div>
  <div class="card">
    <button class="ghost block" data-act="sample">예시 데이터 넣어보기</button>
    <button class="ghost danger block" style="margin-top:8px" data-act="wipe">모든 기록 지우기</button>
  </div>
  <div class="sec-title">급여는 이렇게 계산해요</div>
  <div class="card note" style="margin-top:0;font-size:13px;line-height:1.7">
    · <b>기본급</b> = 일한 시간(휴게 빼고) × 시급<br>
    · <b>주휴수당</b>: 월~일 한 주에 15시간 이상 일하고 빠진 날이 없으면 하루치 정도를 더 받아요 (주 40시간이면 8시간분)<br>
    · <b>야간·연장·휴일수당</b>: 직원 5명 이상인 가게만 받아요. 밤 10시~새벽 6시, 하루 8시간 넘게, 휴일에 일한 시간은 시급의 1.5배<br>
    · <b>3.3%</b>: 세금 3% + 지방세 0.3%를 떼요<br>
    · <b>4대보험</b>: 국민연금·건강보험·장기요양·고용보험을 떼요 (근로소득세는 아직 계산에 없어요)<br>
    · <b>최저시급</b>: 2026년 10,320원, 2027년 10,700원
  </div>
  <div class="note" style="text-align:center;margin:14px 0">알바노트 v1.1 · 기록은 외부로 전송되지 않아요</div>`;
}

function emptyJobs() {
  return `<div class="empty-state"><b>먼저 알바를 등록해 주세요</b>시급과 급여일을 넣으면 달력에서 바로 계산돼요.<br><br>
    <button class="primary" data-act="newJob">+ 알바 추가</button><br><br>
    <button class="ghost" data-act="sample">예시 데이터로 둘러보기</button></div>`;
}

/* ---------- 시트 ---------- */
function openSheet(html) { $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#overlay').classList.add('open'); }
function closeSheet() { $('#overlay').classList.remove('open'); if (SYNC.pendingRender) { SYNC.pendingRender = false; render(); } }
function toggle(id, on, label, sub) {
  return `<div class="tg"><span class="lbl">${label}${sub ? `<small>${sub}</small>` : ''}</span><label class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label></div>`;
}
function openDay(ds) {
  const d = parseYMD(ds), wk = '일월화수목금토'[d.getDay()];
  const ss = shiftsBetween(ds, ds).filter(s => jobById(s.jobId)).sort((a, b) => a.start.localeCompare(b.start));
  const pays = paydaysInMonth(d.getFullYear(), d.getMonth())[ds] || [];
  let h = `<h2>${d.getMonth() + 1}월 ${d.getDate()}일 (${wk})</h2>`;
  pays.forEach(p => h += `<div class="payinfo">💰 <b>${esc(p.job.name)}</b> 급여일 · ${p.month}월분 예상 ${won(p.net)}</div>`);
  if (d.getDay() === 0) {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6);
    S.jobs.forEach(j => { const w = juhyuForWeek(j, mon); if (w && w.pay > 0) h +=`<div class="payinfo" style="background:var(--card);border:1px solid var(--line)">이번 주 <b>${esc(j.name)}</b> 주휴수당 +${won(w.pay)} (주 ${Math.round(w.hours * 10) / 10}시간 근무)</div>`; });
  }
  if (!ss.length) h += '<div class="note" style="margin:6px 0 4px">이날은 근무가 없어요.</div>';
  ss.forEach(s => {
    const j = jobById(s.jobId), c = calcShift(s, j);
    const extra = [c.nightPay && `야간 +${won(c.nightPay)}`, c.otPay && `연장 +${won(c.otPay)}`, c.holPay && `휴일 +${won(c.holPay)}`].filter(Boolean).join(' · ');
    h += `<button class="dayitem" style="--c:${j.color}" data-act="editShift" data-id="${esc(s.id)}">
      <span class="t"><span>${esc(j.name)}</span><span class="num">${s.absent ? '결근' : won(c.pay)}</span></span>
      <small>${s.start}~${s.end} · ${fmtH(c.work)}${s.breakMin ? ` (휴게 ${s.breakMin}분)` : ''}${s.holiday ? ' · 휴일근무' : ''}${s.ruleId ? ' · 🔁 매주 반복' : ''}</small>
      ${extra ? `<small>${extra}</small>` : ''}${s.memo ? `<small>📝 ${esc(s.memo)}</small>` : ''}</button>`;
  });
  h += `<button class="primary block" data-act="newShift" data-date="${ds}">+ 근무 추가</button>`;
  openSheet(h);
}
// 24시간제 시간 선택 (시 00~23, 분 00~59)
function timeSel(id, val) {
  const [h, m] = (RX.time.test(val) ? val : '09:00').split(':');
  const mins = Array.from({ length: 60 }, (_, i) => pad(i));
  return `<div class="tsel"><select id="${id}H" aria-label="시">${Array.from({ length: 24 }, (_, i) => `<option value="${pad(i)}" ${pad(i) === h ? 'selected' : ''}>${pad(i)}시</option>`).join('')}</select>
    <select id="${id}M" aria-label="분">${mins.map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${x}분</option>`).join('')}</select></div>`;
}
const readTime = id => `${$('#' + id + 'H').value}:${$('#' + id + 'M').value}`;
const setTime = (id, v) => { const [h, m] = v.split(':'); $('#' + id + 'H').value = h;
  const ms = $('#' + id + 'M'); if (![...ms.options].some(o => o.value === m)) ms.add(new Option(m + '분', m)); ms.value = m; };
const numInput = (id, val, ph = '') => `<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="${id}" value="${val}" placeholder="${ph}">`;

function openShift(date, id) {
  if (!S.jobs.length) { toast('먼저 알바를 등록해 주세요'); return; }
  const s = id ? findShift(id) : null;
  if (id && !s) return;
  const occ = !!(s && s.ruleId);
  const j0 = s ? jobById(s.jobId) : S.jobs[0];
  const v = s || { jobId: j0.id, date, start: j0.defStart, end: j0.defEnd, breakMin: j0.breakMin, holiday: false, absent: false, memo: '' };
  let btns;
  if (occ) btns = `<div class="btns"><button class="primary" data-act="occSave" data-id="${esc(s.id)}">이날만 바꾸기</button><button class="ghost" data-act="occFuture" data-id="${esc(s.id)}">이날부터 모두 바꾸기</button></div>
      <div class="btns" style="margin-top:8px"><button class="ghost danger" data-act="occSkip" data-id="${esc(s.id)}">이날만 빼기</button><button class="ghost danger" data-act="occEnd" data-id="${esc(s.id)}">이날부터 반복 끝내기</button></div>`;
  else btns = `<div class="btns">${s ? `<button class="ghost danger" data-act="delShift" data-id="${esc(s.id)}">삭제</button>` : ''}<button class="primary" data-act="saveShift" data-id="${s ? esc(s.id) : ''}">저장</button></div>`;
  openSheet(`<h2>${s ? '근무 수정' : '근무 추가'}</h2>
    ${occ ? `<div class="payinfo">🔁 매주 ${WK[parseYMD(s.date).getDay()]}요일 반복 근무예요. 이날만 바꿀지, 이날부터 모두 바꿀지 골라주세요.</div>` : ''}
    <label class="f"><span>알바</span><select id="sJob" ${occ ? 'disabled' : ''}>${S.jobs.map(j => `<option value="${esc(j.id)}" ${j.id === v.jobId ? 'selected' : ''}>${esc(j.name)}</option>`).join('')}</select></label>
    <label class="f"><span>날짜 <b id="sWk"></b></span><input type="date" id="sDate" value="${v.date}" ${occ ? 'disabled' : ''}></label>
    <div class="row2"><div class="f"><span>출근</span>${timeSel('sStart', v.start)}</div><div class="f"><span>퇴근</span>${timeSel('sEnd', v.end)}</div></div>
    <label class="f"><span>휴게시간 (분)</span>${numInput('sBreak', v.breakMin, '0')}</label>
    ${toggle('sHoliday', v.holiday, '휴일 근무', '5인 이상이면 시급 1.5배')}
    ${occ ? '' : toggle('sAbsent', v.absent, '결근', '그날 급여 0원, 그 주 주휴수당 없음')}
    ${s ? '' : `<label class="f"><span>반복</span><select id="sRepeat"><option value="none">반복 안 함</option><option value="weekly">매주 같은 요일에 반복</option></select></label>
      <div id="sRepeatOpts" hidden>
        <label class="f"><span>언제까지 반복할까요?</span><select id="sEndMode"><option value="none">끝나는 날 없이 계속 (나중에 끝낼 수 있어요)</option><option value="date">끝나는 날 정하기</option></select></label>
        <label class="f" id="sUntilWrap" hidden><span>마지막 근무일</span><input type="date" id="sUntil"></label>
      </div>`}
    ${occ ? '' : `<label class="f"><span>메모</span><input id="sMemo" value="${esc(v.memo)}" maxlength="200" placeholder="선택"></label>`}
    <div class="preview" id="sPrev"></div>
    ${btns}`);
  $('#sJob').addEventListener('change', () => {
    if (!s) { const j = jobById($('#sJob').value); setTime('sStart', j.defStart); setTime('sEnd', j.defEnd); $('#sBreak').value = j.breakMin; }
    previewShift();
  });
  $('#sheet').oninput = previewShift;
  $('#sheet').onchange = previewShift;
  previewShift();
}
function readShift() {
  return { jobId: $('#sJob').value, date: $('#sDate').value, start: readTime('sStart'), end: readTime('sEnd'),
    breakMin: Math.min(1440, digits($('#sBreak').value)), holiday: $('#sHoliday').checked,
    absent: $('#sAbsent') ? $('#sAbsent').checked : false, memo: $('#sMemo') ? str($('#sMemo').value.trim(), 200) : '' };
}
function previewShift() {
  const el = $('#sPrev'); if (!el) return;
  const rep = $('#sRepeat');
  if (rep) {
    const weekly = rep.value === 'weekly';
    $('#sRepeatOpts').hidden = !weekly;
    $('#sUntilWrap').hidden = !(weekly && $('#sEndMode').value === 'date');
  }
  const v = readShift(), j = jobById(v.jobId);
  const wk = $('#sWk');
  if (wk) wk.textContent = RX.date.test(v.date) ? `· ${Number(v.date.slice(5, 7))}월 ${Number(v.date.slice(8))}일 ${WK[parseYMD(v.date).getDay()]}요일` : '';
  if (!RX.date.test(v.date)) { el.textContent = '날짜를 골라주세요'; return; }
  if (v.start === v.end) { el.textContent = '출근과 퇴근 시간이 같아요'; return; }
  if (v.absent) { el.innerHTML = '결근 처리 · <b>0원</b>'; return; }
  const c = calcShift(v, j);
  const extra = [c.nightPay && `야간 +${won(c.nightPay)}`, c.otPay && `연장 +${won(c.otPay)}`, c.holPay && `휴일 +${won(c.holPay)}`].filter(Boolean).join(' · ');
  const repLine = rep && rep.value === 'weekly' ? `<br>🔁 매주 ${WK[parseYMD(v.date).getDay()]}요일 반복` : '';
  el.innerHTML = `${fmtH(c.work)} 근무${c.nightMin >= 1 ? ` · 야간 ${fmtH(c.nightMin)}` : ''}${toMin(v.end) <= toMin(v.start) ? ' · 다음날 퇴근' : ''}<br>하루 예상 <b>${won(c.pay)}</b>${extra ? `<br><small>${extra}</small>` : ''}${repLine}
    ${j.wage < minWage(v.date) ? `<div class="warn">이 날짜의 최저시급(${minWage(v.date).toLocaleString()}원)보다 시급이 낮아요</div>` : ''}`;
}
function openRuleEnd(rid) {
  const r = S.repeats.find(x => x.id === rid); if (!r) return;
  const j = jobById(r.jobId);
  openSheet(`<h2>반복 근무 끝내기</h2>
    <div class="payinfo">${esc(j.name)} · 매주 ${WK[parseYMD(r.from).getDay()]}요일 ${r.start}~${r.end}<br><small>${r.from.replace(/-/g, '.')}부터</small></div>
    <label class="f"><span>마지막 근무일</span><input type="date" id="rUntil" value="${r.until || ymd(now)}" min="${r.from}"></label>
    <div class="note" style="margin:-4px 0 10px">이날 이후의 반복 근무만 사라지고, 지난 기록은 그대로 남아요.</div>
    <div class="btns">${r.until ? `<button class="ghost" data-act="ruleForever" data-id="${esc(r.id)}">다시 계속 반복</button>` : ''}<button class="primary" data-act="ruleUntil" data-id="${esc(r.id)}">저장</button></div>
    <button class="ghost danger block" style="margin-top:14px" data-act="ruleDelete" data-id="${esc(r.id)}">반복 근무 통째로 삭제 (지난 기록 포함)</button>`);
}
function openJob(id) {
  const j = id ? jobById(id) : null;
  const v = j || { name: '', color: PALETTE[S.jobs.length % PALETTE.length], wage: minWage(ymd(now)), payday: 10, payNext: true, size5: false, juhyu: true, deduct: 'none', breakMin: 0, defStart: '09:00', defEnd: '18:00' };
  openSheet(`<h2>${j ? '알바 수정' : '알바 추가'}</h2>
    <label class="f"><span>이름</span><input id="jName" value="${esc(v.name)}" maxlength="30" placeholder="예: 편의점"></label>
    <div class="f"><span>색상</span><div class="colors" id="jColors">${PALETTE.map(c => `<button type="button" data-color="${c}" class="${c === v.color ? 'sel' : ''}" style="background:${c}" aria-label="색상"></button>`).join('')}</div></div>
    <label class="f"><span>시급 (원)</span>${numInput('jWage', v.wage, '10700')}</label>
    <div class="note" id="jWageNote" style="margin:-4px 0 10px"></div>
    <div class="row2">
      <label class="f"><span>급여일</span><select id="jPayday">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${v.payday === i + 1 ? 'selected' : ''}>매월 ${i + 1}일</option>`).join('')}</select></label>
      <label class="f"><span>지급 시점</span><select id="jPayNext"><option value="1" ${v.payNext ? 'selected' : ''}>다음 달 (익월)</option><option value="0" ${!v.payNext ? 'selected' : ''}>그 달 (당월)</option></select></label>
    </div>
    <label class="f"><span>공제</span><select id="jDeduct">
      <option value="none" ${v.deduct === 'none' ? 'selected' : ''}>공제 없음</option>
      <option value="33" ${v.deduct === '33' ? 'selected' : ''}>3.3% (사업소득)</option>
      <option value="ins" ${v.deduct === 'ins' ? 'selected' : ''}>4대보험</option></select></label>
    ${toggle('jSize5', v.size5, '직원 5명 이상인 가게', '켜면 야간·연장·휴일에 시급 1.5배')}
    ${toggle('jJuhyu', v.juhyu, '주휴수당 받기', '주 15시간 이상, 빠진 날 없으면 자동 계산')}
    <div class="sec-title" style="margin-top:12px">기본 근무시간</div>
    <div class="note" style="margin:-4px 0 10px">근무를 추가할 때 자동으로 입력돼요</div>
    <div class="row2"><div class="f"><span>출근</span>${timeSel('jStart', v.defStart)}</div><div class="f"><span>퇴근</span>${timeSel('jEnd', v.defEnd)}</div></div>
    <label class="f"><span>휴게시간 (분)</span>${numInput('jBreak', v.breakMin, '0')}</label>
    <div class="btns">${j ? `<button class="ghost danger" data-act="delJob" data-id="${esc(j.id)}">삭제</button>` : ''}<button class="primary" data-act="saveJob" data-id="${j ? esc(j.id) : ''}">저장</button></div>`);
  const note = () => { const w = digits($('#jWage').value), mw = minWage(ymd(now));
    $('#jWageNote').innerHTML = w && w < mw ? `<span style="color:var(--warn)">현재 최저시급 ${mw.toLocaleString()}원보다 낮아요</span>` : '최저시급: 2026년 10,320원 · 2027년 10,700원'; };
  $('#jWage').addEventListener('input', note); note();
}

function openExtra(jobId) {
  const j = jobById(jobId);
  openSheet(`<h2>기타 내역 · ${esc(j.name)}</h2>
    <div class="note" style="margin:-6px 0 12px">${view.y}년 ${view.m + 1}월 급여에 반영돼요.</div>
    <label class="f"><span>종류</span><select id="xKind"><option value="plus">더하기 — 상여·식대·기타 수당 (세전에 포함)</option><option value="minus">빼기 — 가불·기타 차감 (실수령에서 차감)</option></select></label>
    <label class="f"><span>이름</span><input id="xLabel" maxlength="30" placeholder="예: 명절 상여, 가불"></label>
    <label class="f"><span>금액 (원)</span>${numInput('xAmount', '', '예: 50000')}</label>
    <div class="btns"><button class="primary" data-act="saveExtra" data-id="${esc(j.id)}">저장</button></div>`);
}

/* ---------- 백업 ---------- */
function markBackup() { S.lastBackup = ymd(new Date()); save(); }
function applyImport(text, btn) {
  let d;
  try { d = clean(JSON.parse(text)); } catch (_) { toast('올바른 백업 파일이 아니에요'); return; }
  if (btn && !armed(btn, '현재 데이터를 덮어써요 · 한 번 더')) return;
  if (!btn && (S.jobs.length || S.shifts.length)) { // 파일로 불러올 때는 확인 창
    pendingImport = d;
    openSheet(`<h2>백업 불러오기</h2><div class="note" style="margin-bottom:12px">파일: 알바 ${d.jobs.length}개 · 근무 ${d.shifts.length}건<br>지금 기기에 있는 데이터(알바 ${S.jobs.length}개 · 근무 ${S.shifts.length}건)는 지워지고 파일 내용으로 바뀌어요.</div>
      <div class="btns"><button class="ghost" data-act="closeSheet">취소</button><button class="primary" data-act="confirmImport">덮어쓰기</button></div>`);
    return;
  }
  finishImport(d);
}
let pendingImport = null;
function finishImport(d) { S = d; save(); closeSheet(); render(); toast(`불러왔어요 (알바 ${d.jobs.length}개 · 근무 ${d.shifts.length}건)`); }

/* ---------- 동작 ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2000); }
function armed(btn, label) { // 되돌릴 수 없는 동작은 두 번 눌러 확인
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label || '한 번 더 누르면 실행';
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 3000);
  return false;
}
function sampleData() {
  const a = { id: uid(), name: '편의점', color: PALETTE[0], wage: 10320, payday: 10, payNext: true, size5: false, juhyu: true, deduct: '33', breakMin: 0, defStart: '18:00', defEnd: '23:00' };
  const b = { id: uid(), name: '카페', color: PALETTE[2], wage: 11000, payday: 25, payNext: false, size5: true, juhyu: true, deduct: 'ins', breakMin: 60, defStart: '14:00', defEnd: '23:00' };
  S.jobs.push(a, b);
  const start = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const firstOn = wd => addDays(start, (wd - parseYMD(start).getDay() + 7) % 7);
  [1, 3, 5].forEach(wd => S.repeats.push({ id: uid(), jobId: a.id, from: firstOn(wd), until: null, start: '18:00', end: '23:00', breakMin: 0, holiday: false, skip: [] }));
  S.repeats.push({ id: uid(), jobId: b.id, from: firstOn(6), until: null, start: '14:00', end: '23:00', breakMin: 60, holiday: false, skip: [] });
  save(); view.tab = 'cal'; render(); toast('예시 데이터를 넣었어요');
}
const ruleOf = s => s && S.repeats.find(r => r.id === s.ruleId);
document.addEventListener('click', e => {
  if (e.target.id === 'overlay') return closeSheet();
  const cb = e.target.closest('#jColors button');
  if (cb) { document.querySelectorAll('#jColors button').forEach(b => b.classList.toggle('sel', b === cb)); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  const done = msg => { save(); closeSheet(); render(); if (msg) toast(msg); };
  switch (act) {
    case 'tab': view.tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'prev': view.m--; if (view.m < 0) { view.m = 11; view.y--; } render(); break;
    case 'next': view.m++; if (view.m > 11) { view.m = 0; view.y++; } render(); break;
    case 'thisMonth': view.y = now.getFullYear(); view.m = now.getMonth(); render(); break;
    case 'day': openDay(el.dataset.date); break;
    case 'newShift': openShift(el.dataset.date); break;
    case 'addShiftToday': {
      const isNow = view.y === now.getFullYear() && view.m === now.getMonth();
      openShift(isNow ? ymd(now) : `${view.y}-${pad(view.m + 1)}-01`); break;
    }
    case 'editShift': openShift(null, id); break;
    case 'saveShift': {
      const v = readShift();
      if (!RX.date.test(v.date)) return toast('날짜를 골라주세요');
      if (v.start === v.end) return toast('출근과 퇴근 시간이 같아요');
      if (!jobById(v.jobId)) return toast('알바를 선택해 주세요');
      if (id) { Object.assign(S.shifts.find(s => s.id === id), v); return done('수정했어요'); }
      if ($('#sRepeat').value === 'weekly') {
        if (v.absent) return toast('결근은 반복으로 넣을 수 없어요');
        let until = null;
        if ($('#sEndMode').value === 'date') {
          until = $('#sUntil').value;
          if (!RX.date.test(until)) return toast('마지막 근무일을 골라주세요');
          if (until < v.date) return toast('마지막 근무일이 시작일보다 빨라요');
        }
        S.repeats.push({ id: uid(), jobId: v.jobId, from: v.date, until, start: v.start, end: v.end, breakMin: v.breakMin, holiday: v.holiday, skip: [] });
        return done(`매주 ${WK[parseYMD(v.date).getDay()]}요일 반복 근무를 넣었어요`);
      }
      S.shifts.push({ ...v, id: uid() });
      return done('근무를 추가했어요');
    }
    case 'delShift':
      if (!armed(el, '한 번 더 누르면 삭제')) return;
      S.shifts = S.shifts.filter(s => s.id !== id); return done('삭제했어요');
    // 반복 근무의 하루
    case 'occSave': { // 이날만 바꾸기: 반복에서 이날을 빼고 따로 저장
      const s = findShift(id), rule = ruleOf(s), v = readShift(); if (!rule) return;
      if (v.start === v.end) return toast('출근과 퇴근 시간이 같아요');
      rule.skip.push(s.date);
      S.shifts.push({ ...v, id: uid(), jobId: rule.jobId, date: s.date, absent: false, memo: '' });
      return done('이날만 바꿨어요');
    }
    case 'occFuture': { // 이날부터 모두 바꾸기: 반복을 둘로 나눔
      const s = findShift(id), rule = ruleOf(s), v = readShift(); if (!rule) return;
      if (v.start === v.end) return toast('출근과 퇴근 시간이 같아요');
      const nr = { id: uid(), jobId: rule.jobId, from: s.date, until: rule.until, start: v.start, end: v.end, breakMin: v.breakMin, holiday: v.holiday, skip: rule.skip.filter(d => d > s.date) };
      if (s.date <= rule.from) S.repeats = S.repeats.filter(r => r !== rule); else rule.until = addDays(s.date, -1);
      S.repeats.push(nr);
      return done('이날부터 모두 바꿨어요');
    }
    case 'occSkip': {
      if (!armed(el, '한 번 더 누르면 빼기')) return;
      const s = findShift(id), rule = ruleOf(s); if (!rule) return;
      rule.skip.push(s.date); return done('이날만 뺐어요');
    }
    case 'occEnd': {
      if (!armed(el, '한 번 더 누르면 끝내기')) return;
      const s = findShift(id), rule = ruleOf(s); if (!rule) return;
      if (s.date <= rule.from) S.repeats = S.repeats.filter(r => r !== rule); else rule.until = addDays(s.date, -1);
      return done('반복을 끝냈어요. 지난 기록은 남아 있어요');
    }
    // 알바 탭의 반복 근무 관리
    case 'ruleEnd': openRuleEnd(id); break;
    case 'ruleUntil': {
      const r = S.repeats.find(x => x.id === id), u = $('#rUntil').value; if (!r) return;
      if (!RX.date.test(u)) return toast('날짜를 골라주세요');
      if (u < r.from) return toast(`${r.from.replace(/-/g, '.')} 이후로 골라주세요`);
      r.until = u; return done('종료일을 저장했어요');
    }
    case 'ruleForever': { const r = S.repeats.find(x => x.id === id); if (r) r.until = null; return done('다시 계속 반복해요'); }
    case 'ruleDelete':
      if (!armed(el, '지난 기록까지 지워져요 · 한 번 더')) return;
      S.repeats = S.repeats.filter(r => r.id !== id); return done('삭제했어요');
    case 'newJob': openJob(); break;
    case 'editJob': openJob(id); break;
    case 'saveJob': {
      const name = str($('#jName').value.trim(), 30), wage = Math.min(1e6, digits($('#jWage').value));
      if (!name) return toast('이름을 입력해 주세요');
      if (!(wage > 0)) return toast('시급을 입력해 주세요');
      const color = (document.querySelector('#jColors .sel') || {}).dataset?.color;
      const v = { name, wage, color: RX.hex.test(color) ? color : PALETTE[0],
        payday: Math.round(num($('#jPayday').value, 10, 1, 31)), payNext: $('#jPayNext').value === '1',
        deduct: ['none', '33', 'ins'].includes($('#jDeduct').value) ? $('#jDeduct').value : 'none',
        size5: $('#jSize5').checked, juhyu: $('#jJuhyu').checked,
        defStart: readTime('jStart'), defEnd: readTime('jEnd'), breakMin: Math.min(1440, digits($('#jBreak').value)) };
      if (id) Object.assign(jobById(id), v); else S.jobs.push({ id: uid(), ...v });
      return done('저장했어요');
    }
    case 'delJob':
      if (!armed(el, '근무 기록까지 삭제 · 한 번 더')) return;
      S.jobs = S.jobs.filter(j => j.id !== id); S.shifts = S.shifts.filter(s => s.jobId !== id);
      S.extras = S.extras.filter(x => x.jobId !== id); S.repeats = S.repeats.filter(r => r.jobId !== id);
      return done();
    case 'newExtra': openExtra(id); break;
    case 'saveExtra': {
      const amount = Math.min(1e9, digits($('#xAmount').value));
      if (!(amount > 0)) return toast('금액을 입력해 주세요');
      S.extras.push({ id: uid(), jobId: id, month: `${view.y}-${pad(view.m + 1)}`, kind: $('#xKind').value === 'minus' ? 'minus' : 'plus', label: str($('#xLabel').value.trim(), 30) || '기타', amount });
      return done('추가했어요');
    }
    case 'delExtra':
      if (!armed(el, '삭제?')) return;
      S.extras = S.extras.filter(x => x.id !== id); save(); render(); break;
    case 'exportFile': {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `알바노트-기록-${ymd(new Date())}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      markBackup(); render(); toast('기록 파일을 만들었어요'); break;
    }
    case 'importFile': $('#fileIn').value = ''; $('#fileIn').click(); break;
    case 'copyBk': {
      const ta = $('#bk'); ta.value = JSON.stringify(S);
      (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject())
        .then(() => { markBackup(); renderBanner(); toast('복사했어요. 메모 앱에 붙여넣어 두세요'); },
          () => { ta.focus(); ta.select(); toast('선택된 글자를 직접 복사해 주세요'); });
      break;
    }
    case 'importBk': applyImport($('#bk').value, el); break;
    case 'confirmImport': if (pendingImport) { finishImport(pendingImport); pendingImport = null; } break;
    case 'closeSheet': closeSheet(); break;
    case 'newCode':
      makeCode().then(({ code, hash }) => {
        pendingCode = code;
        openSheet(`<h2>새 동기화 코드</h2>
          <div class="note" style="font-size:13.5px;color:var(--ink)">① <b>동기화 코드</b>는 맥의 <b>'암호'</b> 앱에 새 암호로 저장해 두세요(아이폰에도 자동으로 옮겨져요). <b>AI나 다른 사람에게 절대 보여주지 마세요.</b></div>
          <label class="f"><textarea id="ncCode" readonly>${esc(code)}</textarea></label>
          <button class="ghost block" data-act="copyNc" data-src="ncCode">동기화 코드 복사</button>
          <div class="note" style="font-size:13.5px;color:var(--ink);margin-top:14px">② <b>서버 등록용 값</b>은 코드를 거꾸로 알아낼 수 없는 값이에요. Aside에게는 이 값만 알려주면 돼요.</div>
          <label class="f"><textarea id="ncHash" readonly>${esc(hash)}</textarea></label>
          <button class="ghost block" data-act="copyNc" data-src="ncHash">서버 등록용 값 복사</button>
          <div class="btns"><button class="ghost" data-act="closeSheet">취소</button><button class="primary" data-act="useNewCode">코드 저장했어요</button></div>`);
      }, () => toast('이 브라우저에서는 코드를 만들 수 없어요'));
      break;
    case 'copyNc': {
      const v = $('#' + el.dataset.src).value;
      navigator.clipboard.writeText(v).then(() => toast('복사했어요'), () => { $('#' + el.dataset.src).select(); toast('길게 눌러 복사해 주세요'); });
      break;
    }
    case 'useNewCode':
      if (pendingCode) { setCode(pendingCode); pendingCode = null; }
      closeSheet(); SYNC.state = 'wait'; render(); syncNow(); toast('이 기기에 코드를 저장했어요');
      break;
    case 'saveCode': {
      const c = ($('#syncCode').value || '').replace(/\s+/g, '');
      if (!CODE_RX.test(c)) { toast('코드 형식이 맞지 않아요'); break; }
      setCode(c); SYNC.state = 'wait'; render(); syncNow();
      break;
    }
    case 'forgetCode':
      setCode(null); SYNC.state = 'nocode'; render(); toast('이 기기에서 코드를 지웠어요. 기록은 그대로 있어요');
      break;
    case 'syncNow': syncNow().then(() => toast(SYNC.state === 'ok' ? '동기화했어요' : SYNC_TEXT[SYNC.state])); break;
    case 'sample': sampleData(); break;
    case 'wipe':
      if (!armed(el, '정말 모두 지울까요? 한 번 더')) return;
      S = emptyData(); save(); render(); toast('모두 지웠어요'); break;
  }
});
$('#fileIn').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  if (f.size > 5 * 1024 * 1024) return toast('파일이 너무 커요');
  f.text().then(t => applyImport(t, null));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

render();

// 동기화: 열 때, 앱으로 돌아올 때, 인터넷이 다시 연결될 때
if (SYNC_ON) {
  syncNow();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setSync('offline'));
  setInterval(() => { if (document.visibilityState === 'visible' && SYNC.state === 'error') syncNow(); }, 60000);
}

// 오프라인 지원 (https에서만)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
