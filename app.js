'use strict';
/* 알바노트 — 외부 라이브러리 없이 동작하는 개인용 알바 급여 웹앱 */

/* ---------- 기본 설정 ---------- */
const KEY = 'albanote.v1';
const PALETTE = ['#2F7D5B', '#C2573A', '#3B6EA8', '#9A6BB8', '#C9952B', '#4A9A9A', '#B5476E', '#6B7A3A'];
const DEFAULT_RATES = { pension: 4.75, health: 3.595, ltc: 13.14, emp: 0.9 }; // 2026년 근로자 부담분
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
  const r = d.rates || {};
  const rates = { pension: num(r.pension, DEFAULT_RATES.pension, 0, 50), health: num(r.health, DEFAULT_RATES.health, 0, 50), ltc: num(r.ltc, DEFAULT_RATES.ltc, 0, 100), emp: num(r.emp, DEFAULT_RATES.emp, 0, 50) };
  return { jobs, shifts, extras, rates, lastBackup: RX.date.test(d.lastBackup) ? d.lastBackup : null };
}
const emptyData = () => ({ jobs: [], shifts: [], extras: [], rates: { ...DEFAULT_RATES }, lastBackup: null });

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
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { storageOK = false; renderBanner(); } }
// 브라우저가 저장공간을 임의로 지우지 않도록 요청
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}

const now = new Date();
const view = { y: now.getFullYear(), m: now.getMonth(), tab: 'cal' };
const jobById = id => S.jobs.find(j => j.id === id);

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
  const ss = S.shifts.filter(s => s.jobId === job.id && days.includes(s.date));
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
function deduct(gross, type, r) {
  if (type === '33') {
    const tax = t10(gross * 0.03), loc = t10(tax * 0.1);
    return { items: [['소득세 3%', tax], ['지방소득세 0.3%', loc]], sum: tax + loc };
  }
  if (type === 'ins') {
    const p = t10(gross * r.pension / 100), h = t10(gross * r.health / 100), l = t10(h * r.ltc / 100), e = t10(gross * r.emp / 100);
    return { items: [[`국민연금 ${r.pension}%`, p], [`건강보험 ${r.health}%`, h], [`장기요양 (건보료×${r.ltc}%)`, l], [`고용보험 ${r.emp}%`, e]], sum: p + h + l + e };
  }
  return { items: [], sum: 0 };
}
function monthJob(job, y, m) {
  const mk = `${y}-${pad(m + 1)}`;
  const ss = S.shifts.filter(s => s.jobId === job.id && s.date.startsWith(mk));
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
  r.ded = deduct(r.gross, job.deduct, S.rates);
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
  if (!storageOK) h = '<div class="warn">이 브라우저에서는 데이터 저장이 막혀 있어요. 창을 닫으면 입력한 내용이 사라지니, 설정 › 백업으로 저장해 두세요.</div>';
  else if (S.shifts.length) {
    const days = S.lastBackup ? (now - parseYMD(S.lastBackup)) / 864e5 : Infinity;
    if (days > BACKUP_REMIND_DAYS) h = `<div class="warn">${S.lastBackup ? `마지막 백업이 ${Math.floor(days)}일 전이에요.` : '아직 백업한 적이 없어요.'} 설정 › 백업에서 파일로 저장해 두세요.</div>`;
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
  let h = '<div class="dow">' + ['일', '월', '화', '수', '목', '금', '토'].map((d, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</span>`).join('') + '</div><div class="grid">';
  for (let i = 0; i < first; i++) h += '<div class="cell empty"></div>';
  for (let d = 1; d <= last; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`, dow = (first + d - 1) % 7, future = ds > today;
    const ss = S.shifts.filter(s => s.date === ds && jobById(s.jobId)).sort((a, b) => a.start.localeCompare(b.start));
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
  return h + '</div><button class="primary block" data-act="newJob">+ 알바 추가</button>';
}
function renderSettings() {
  const r = S.rates;
  return `
  <div class="sec-title">백업</div>
  <div class="card">
    <div class="note" style="margin:0 0 10px">데이터는 이 기기에만 저장돼요. 폰을 바꾸거나 브라우저 데이터를 지우면 사라지니, 가끔 파일로 저장해 두세요.${S.lastBackup ? ` (마지막 백업 ${S.lastBackup})` : ''}</div>
    <div class="btns" style="margin-top:0"><button class="primary" data-act="exportFile">파일로 저장</button><button class="ghost" data-act="importFile">파일 불러오기</button></div>
    <details><summary>파일 저장이 안 될 때: 텍스트로 복사·붙여넣기</summary>
      <label class="f" style="margin-top:8px"><textarea id="bk">${esc(JSON.stringify(S))}</textarea></label>
      <div class="btns" style="margin-top:0"><button class="ghost" data-act="copyBk">복사</button><button class="ghost" data-act="importBk">붙여넣은 내용 불러오기</button></div>
    </details>
  </div>
  <div class="sec-title">4대보험 요율 (근로자 부담, %)</div>
  <div class="card">
    <div class="row2">
      <label class="f"><span>국민연금</span><input type="number" step="0.001" id="rPension" value="${r.pension}"></label>
      <label class="f"><span>건강보험</span><input type="number" step="0.001" id="rHealth" value="${r.health}"></label>
      <label class="f"><span>장기요양 (건보료 대비)</span><input type="number" step="0.01" id="rLtc" value="${r.ltc}"></label>
      <label class="f"><span>고용보험</span><input type="number" step="0.01" id="rEmp" value="${r.emp}"></label>
    </div>
    <div class="btns"><button class="ghost" data-act="resetRates">2026년 기본값</button><button class="primary" data-act="saveRates">요율 저장</button></div>
    <div class="note">국민연금은 2033년까지 매년 0.5%p씩 오를 예정이라, 해가 바뀌면 여기서 고쳐주세요.</div>
  </div>
  <div class="sec-title">기타</div>
  <div class="card">
    <button class="ghost block" data-act="sample">예시 데이터 넣기</button>
    <button class="ghost danger block" style="margin-top:8px" data-act="wipe">모든 데이터 지우기</button>
  </div>
  <div class="sec-title">계산 기준</div>
  <div class="card note" style="margin-top:0">
    · 주휴수당: 주(월~일) 15시간 이상이고 결근이 없으면 (주 근로시간, 최대 40) ÷ 40 × 8 × 시급<br>
    · 야간(22~06시)·연장(하루 8시간 초과)·휴일 +50%, 휴일 8시간 초과 +100% — 5인 이상 사업장만<br>
    · 3.3%: 소득세 3% + 지방소득세 0.3%, 10원 미만 절사<br>
    · 4대보험: 세전 합계 × 요율, 장기요양은 건강보험료 × 요율. 근로소득세·보험료 상하한은 미반영<br>
    · 상여·수당은 세전에 더하고, 가불은 실수령에서 빼요<br>
    · 최저시급: 2026년 10,320원, 2027년 10,700원
  </div>
  <div class="note" style="text-align:center;margin:14px 0">알바노트 v1.0 · 외부 서버 전송 없음</div>`;
}
function emptyJobs() {
  return `<div class="empty-state"><b>먼저 알바를 등록해 주세요</b>시급과 급여일을 넣으면 달력에서 바로 계산돼요.<br><br>
    <button class="primary" data-act="newJob">+ 알바 추가</button><br><br>
    <button class="ghost" data-act="sample">예시 데이터로 둘러보기</button></div>`;
}

/* ---------- 시트 ---------- */
function openSheet(html) { $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#overlay').classList.add('open'); }
function closeSheet() { $('#overlay').classList.remove('open'); }
function toggle(id, on, label, sub) {
  return `<div class="tg"><span class="lbl">${label}${sub ? `<small>${sub}</small>` : ''}</span><label class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label></div>`;
}
function openDay(ds) {
  const d = parseYMD(ds), wk = '일월화수목금토'[d.getDay()];
  const ss = S.shifts.filter(s => s.date === ds && jobById(s.jobId)).sort((a, b) => a.start.localeCompare(b.start));
  const pays = paydaysInMonth(d.getFullYear(), d.getMonth())[ds] || [];
  let h = `<h2>${d.getMonth() + 1}월 ${d.getDate()}일 (${wk})</h2>`;
  pays.forEach(p => h += `<div class="payinfo">💰 <b>${esc(p.job.name)}</b> 급여일 · ${p.month}월분 예상 ${won(p.net)}</div>`);
  if (d.getDay() === 0) {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6);
    S.jobs.forEach(j => { const w = juhyuForWeek(j, mon); if (w) h += `<div class="payinfo" style="background:var(--card);border:1px solid var(--line)">이번 주 <b>${esc(j.name)}</b> 주휴수당 ${won(w.pay)} · ${w.reason} (${Math.round(w.hours * 10) / 10}시간)</div>`; });
  }
  if (!ss.length) h += '<div class="note" style="margin:6px 0 4px">이날은 근무가 없어요.</div>';
  ss.forEach(s => {
    const j = jobById(s.jobId), c = calcShift(s, j);
    const extra = [c.nightPay && `야간 +${won(c.nightPay)}`, c.otPay && `연장 +${won(c.otPay)}`, c.holPay && `휴일 +${won(c.holPay)}`].filter(Boolean).join(' · ');
    h += `<button class="dayitem" style="--c:${j.color}" data-act="editShift" data-id="${esc(s.id)}">
      <span class="t"><span>${esc(j.name)}</span><span class="num">${s.absent ? '결근' : won(c.pay)}</span></span>
      <small>${s.start}~${s.end} · ${fmtH(c.work)}${s.breakMin ? ` (휴게 ${s.breakMin}분)` : ''}${s.holiday ? ' · 휴일근무' : ''}</small>
      ${extra ? `<small>${extra}</small>` : ''}${s.memo ? `<small>📝 ${esc(s.memo)}</small>` : ''}</button>`;
  });
  h += `<button class="primary block" data-act="newShift" data-date="${ds}">+ 근무 추가</button>`;
  openSheet(h);
}
function openShift(date, id) {
  if (!S.jobs.length) { toast('먼저 알바를 등록해 주세요'); return; }
  const s = id ? S.shifts.find(x => x.id === id) : null;
  const j0 = s ? jobById(s.jobId) : S.jobs[0];
  const v = s || { jobId: j0.id, date, start: j0.defStart, end: j0.defEnd, breakMin: j0.breakMin, holiday: false, absent: false, memo: '' };
  openSheet(`<h2>${s ? '근무 수정' : '근무 추가'}</h2>
    <label class="f"><span>알바</span><select id="sJob">${S.jobs.map(j => `<option value="${esc(j.id)}" ${j.id === v.jobId ? 'selected' : ''}>${esc(j.name)}</option>`).join('')}</select></label>
    <label class="f"><span>날짜</span><input type="date" id="sDate" value="${v.date}"></label>
    <div class="row2"><label class="f"><span>출근</span><input type="time" id="sStart" value="${v.start}"></label><label class="f"><span>퇴근</span><input type="time" id="sEnd" value="${v.end}"></label></div>
    <label class="f"><span>휴게시간 (분)</span><input type="number" inputmode="numeric" id="sBreak" value="${v.breakMin}" min="0" step="10"></label>
    ${toggle('sHoliday', v.holiday, '휴일 근무', '5인 이상이면 +50% (8시간 초과 +100%)')}
    ${toggle('sAbsent', v.absent, '결근', '그날 급여 0원, 그 주 주휴수당 없음')}
    ${s ? '' : `<label class="f"><span>매주 반복</span><select id="sRepeat">${[1, 2, 3, 4, 6, 8, 12].map(n => `<option value="${n}">${n === 1 ? '반복 안 함' : n + '주 동안 같은 요일'}</option>`).join('')}</select></label>`}
    <label class="f"><span>메모</span><input id="sMemo" value="${esc(v.memo)}" maxlength="200" placeholder="선택"></label>
    <div class="preview" id="sPrev"></div>
    <div class="btns">${s ? `<button class="ghost danger" data-act="delShift" data-id="${esc(s.id)}">삭제</button>` : ''}<button class="primary" data-act="saveShift" data-id="${s ? esc(s.id) : ''}">저장</button></div>`);
  $('#sJob').addEventListener('change', () => {
    if (s) return previewShift();
    const j = jobById($('#sJob').value);
    $('#sStart').value = j.defStart; $('#sEnd').value = j.defEnd; $('#sBreak').value = j.breakMin;
    previewShift();
  });
  $('#sheet').oninput = previewShift;
  previewShift();
}
function readShift() {
  return { jobId: $('#sJob').value, date: $('#sDate').value, start: $('#sStart').value, end: $('#sEnd').value,
    breakMin: Math.round(num($('#sBreak').value, 0, 0, 1440)), holiday: $('#sHoliday').checked, absent: $('#sAbsent').checked, memo: str($('#sMemo').value.trim(), 200) };
}
function previewShift() {
  const el = $('#sPrev'); if (!el) return;
  const v = readShift(), j = jobById(v.jobId);
  if (!RX.time.test(v.start) || !RX.time.test(v.end) || !RX.date.test(v.date)) { el.textContent = '날짜와 시간을 입력해 주세요'; return; }
  if (v.start === v.end) { el.textContent = '출근과 퇴근 시간이 같아요'; return; }
  if (v.absent) { el.innerHTML = '결근 처리 · <b>0원</b>'; return; }
  const c = calcShift(v, j);
  const extra = [c.nightPay && `야간 +${won(c.nightPay)}`, c.otPay && `연장 +${won(c.otPay)}`, c.holPay && `휴일 +${won(c.holPay)}`].filter(Boolean).join(' · ');
  el.innerHTML = `${fmtH(c.work)} 근무${c.nightMin >= 1 ? ` · 야간 ${fmtH(c.nightMin)}` : ''}${toMin(v.end) <= toMin(v.start) ? ' · 다음날 퇴근' : ''}<br>예상 <b>${won(c.pay)}</b>${extra ? `<br><small>${extra}</small>` : ''}
    ${j.wage < minWage(v.date) ? `<div class="warn">이 날짜의 최저시급(${minWage(v.date).toLocaleString()}원)보다 시급이 낮아요</div>` : ''}`;
}
function openJob(id) {
  const j = id ? jobById(id) : null;
  const v = j || { name: '', color: PALETTE[S.jobs.length % PALETTE.length], wage: minWage(ymd(now)), payday: 10, payNext: true, size5: false, juhyu: true, deduct: 'none', breakMin: 0, defStart: '09:00', defEnd: '18:00' };
  openSheet(`<h2>${j ? '알바 수정' : '알바 추가'}</h2>
    <label class="f"><span>이름</span><input id="jName" value="${esc(v.name)}" maxlength="30" placeholder="예: 편의점"></label>
    <div class="f"><span>색상</span><div class="colors" id="jColors">${PALETTE.map(c => `<button type="button" data-color="${c}" class="${c === v.color ? 'sel' : ''}" style="background:${c}" aria-label="색상"></button>`).join('')}</div></div>
    <label class="f"><span>시급 (원)</span><input type="number" inputmode="numeric" id="jWage" value="${v.wage}" step="10"></label>
    <div class="note" id="jWageNote" style="margin:-4px 0 10px"></div>
    <div class="row2">
      <label class="f"><span>급여일</span><select id="jPayday">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${v.payday === i + 1 ? 'selected' : ''}>매월 ${i + 1}일</option>`).join('')}</select></label>
      <label class="f"><span>지급 시점</span><select id="jPayNext"><option value="1" ${v.payNext ? 'selected' : ''}>다음 달 (익월)</option><option value="0" ${!v.payNext ? 'selected' : ''}>그 달 (당월)</option></select></label>
    </div>
    <label class="f"><span>공제</span><select id="jDeduct">
      <option value="none" ${v.deduct === 'none' ? 'selected' : ''}>공제 없음</option>
      <option value="33" ${v.deduct === '33' ? 'selected' : ''}>3.3% (사업소득)</option>
      <option value="ins" ${v.deduct === 'ins' ? 'selected' : ''}>4대보험</option></select></label>
    ${toggle('jSize5', v.size5, '5인 이상 사업장', '켜면 야간·연장·휴일 가산수당 적용')}
    ${toggle('jJuhyu', v.juhyu, '주휴수당 적용', '주 15시간 이상·개근 시 자동 계산')}
    <div class="sec-title" style="margin-top:12px">근무 추가할 때 기본값</div>
    <div class="row2"><label class="f"><span>출근</span><input type="time" id="jStart" value="${v.defStart}"></label><label class="f"><span>퇴근</span><input type="time" id="jEnd" value="${v.defEnd}"></label></div>
    <label class="f"><span>휴게시간 (분)</span><input type="number" inputmode="numeric" id="jBreak" value="${v.breakMin}" min="0" step="10"></label>
    <div class="btns">${j ? `<button class="ghost danger" data-act="delJob" data-id="${esc(j.id)}">삭제</button>` : ''}<button class="primary" data-act="saveJob" data-id="${j ? esc(j.id) : ''}">저장</button></div>`);
  const note = () => { const w = Number($('#jWage').value) || 0, mw = minWage(ymd(now));
    $('#jWageNote').innerHTML = w < mw ? `<span style="color:var(--warn)">현재 최저시급 ${mw.toLocaleString()}원보다 낮아요</span>` : '최저시급: 2026년 10,320원 · 2027년 10,700원'; };
  $('#jWage').addEventListener('input', note); note();
}
function openExtra(jobId) {
  const j = jobById(jobId);
  openSheet(`<h2>기타 내역 · ${esc(j.name)}</h2>
    <div class="note" style="margin:-6px 0 12px">${view.y}년 ${view.m + 1}월 급여에 반영돼요.</div>
    <label class="f"><span>종류</span><select id="xKind"><option value="plus">더하기 — 상여·식대·기타 수당 (세전에 포함)</option><option value="minus">빼기 — 가불·기타 차감 (실수령에서 차감)</option></select></label>
    <label class="f"><span>이름</span><input id="xLabel" maxlength="30" placeholder="예: 명절 상여, 가불"></label>
    <label class="f"><span>금액 (원)</span><input type="number" inputmode="numeric" id="xAmount" step="1000" min="0"></label>
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
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1), end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = ymd(d), w = d.getDay();
    if ([1, 3, 5].includes(w)) S.shifts.push({ id: uid(), jobId: a.id, date: ds, start: '18:00', end: '23:00', breakMin: 0, holiday: false, absent: false, memo: '' });
    if (w === 6) S.shifts.push({ id: uid(), jobId: b.id, date: ds, start: '14:00', end: '23:00', breakMin: 60, holiday: false, absent: false, memo: '' });
  }
  save(); view.tab = 'cal'; render(); toast('예시 데이터를 넣었어요');
}
document.addEventListener('click', e => {
  if (e.target.id === 'overlay') return closeSheet();
  const cb = e.target.closest('#jColors button');
  if (cb) { document.querySelectorAll('#jColors button').forEach(b => b.classList.toggle('sel', b === cb)); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
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
      if (!RX.date.test(v.date) || !RX.time.test(v.start) || !RX.time.test(v.end)) return toast('날짜와 시간을 입력해 주세요');
      if (v.start === v.end) return toast('출근과 퇴근 시간이 같아요');
      if (!jobById(v.jobId)) return toast('알바를 선택해 주세요');
      if (id) Object.assign(S.shifts.find(s => s.id === id), v);
      else {
        const n = Number($('#sRepeat').value) || 1, base = parseYMD(v.date);
        for (let i = 0; i < n; i++) S.shifts.push({ ...v, id: uid(), date: ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7 * i)) });
      }
      save(); closeSheet(); render(); toast(id ? '수정했어요' : '근무를 추가했어요'); break;
    }
    case 'delShift':
      if (!armed(el, '한 번 더 누르면 삭제')) return;
      S.shifts = S.shifts.filter(s => s.id !== id); save(); closeSheet(); render(); toast('삭제했어요'); break;
    case 'newJob': openJob(); break;
    case 'editJob': openJob(id); break;
    case 'saveJob': {
      const name = str($('#jName').value.trim(), 30), wage = num($('#jWage').value, 0, 0, 1e6);
      if (!name) return toast('이름을 입력해 주세요');
      if (!(wage > 0)) return toast('시급을 입력해 주세요');
      const color = (document.querySelector('#jColors .sel') || {}).dataset?.color;
      const v = { name, wage, color: RX.hex.test(color) ? color : PALETTE[0],
        payday: Math.round(num($('#jPayday').value, 10, 1, 31)), payNext: $('#jPayNext').value === '1', deduct: $('#jDeduct').value,
        size5: $('#jSize5').checked, juhyu: $('#jJuhyu').checked,
        defStart: RX.time.test($('#jStart').value) ? $('#jStart').value : '09:00', defEnd: RX.time.test($('#jEnd').value) ? $('#jEnd').value : '18:00',
        breakMin: Math.round(num($('#jBreak').value, 0, 0, 1440)) };
      if (id) Object.assign(jobById(id), v); else S.jobs.push({ id: uid(), ...v });
      save(); closeSheet(); render(); toast('저장했어요'); break;
    }
    case 'delJob':
      if (!armed(el, '근무 기록까지 삭제 · 한 번 더')) return;
      S.jobs = S.jobs.filter(j => j.id !== id); S.shifts = S.shifts.filter(s => s.jobId !== id); S.extras = S.extras.filter(x => x.jobId !== id);
      save(); closeSheet(); render(); break;
    case 'newExtra': openExtra(id); break;
    case 'saveExtra': {
      const amount = Math.round(num($('#xAmount').value, 0, 0, 1e9));
      if (!(amount > 0)) return toast('금액을 입력해 주세요');
      S.extras.push({ id: uid(), jobId: id, month: `${view.y}-${pad(view.m + 1)}`, kind: $('#xKind').value === 'minus' ? 'minus' : 'plus', label: str($('#xLabel').value.trim(), 30) || '기타', amount });
      save(); closeSheet(); render(); toast('추가했어요'); break;
    }
    case 'delExtra':
      if (!armed(el, '삭제?')) return;
      S.extras = S.extras.filter(x => x.id !== id); save(); render(); break;
    case 'saveRates':
      S.rates = { pension: num($('#rPension').value, 0, 0, 50), health: num($('#rHealth').value, 0, 0, 50), ltc: num($('#rLtc').value, 0, 0, 100), emp: num($('#rEmp').value, 0, 0, 50) };
      save(); toast('요율을 저장했어요'); break;
    case 'resetRates': S.rates = { ...DEFAULT_RATES }; save(); render(); toast('기본값으로 바꿨어요'); break;
    case 'exportFile': {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `albanote-backup-${ymd(new Date())}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      markBackup(); renderBanner(); toast('백업 파일을 만들었어요'); break;
    }
    case 'importFile': $('#fileIn').value = ''; $('#fileIn').click(); break;
    case 'copyBk': {
      const ta = $('#bk'); ta.value = JSON.stringify(S);
      (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject())
        .then(() => { markBackup(); renderBanner(); toast('복사했어요. 메모 앱 등에 붙여넣어 보관하세요'); },
          () => { ta.focus(); ta.select(); toast('선택된 내용을 직접 복사해 주세요'); });
      break;
    }
    case 'importBk': applyImport($('#bk').value, el); break;
    case 'confirmImport': if (pendingImport) { finishImport(pendingImport); pendingImport = null; } break;
    case 'closeSheet': closeSheet(); break;
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

// 오프라인 지원 (https에서만)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
