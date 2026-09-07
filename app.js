'use strict';

/* =========================================================================
 * OneBoard - 画面(月表示カレンダー / 予定の登録・編集・削除)
 * データ層は events.js。
 * ======================================================================= */

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
const MAX_CHIPS_PER_CELL = 3;

const state = {
  viewYear: 0,
  viewMonth: 0, // 0-11
  today: new Date(),
  occ: new Map(), // 現在描画中グリッドの Map<"YYYY-MM-DD", Event[]>
};

/* ---------- 起動 ---------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Service Worker は https 配信(GitHub Pages など)でのみ使う。
  //  - https:  PWA/オフライン用に sw.js を登録(相対パスなのでスコープはアプリ配下に限定)。
  //  - それ以外(localhost/http・file:): 使わない。姉妹アプリのローカルサーバーと同一
  //    オリジンに古い SW が残っていると誤表示するため掃除する。
  //    (github.io では他アプリの SW を消さないよう、この掃除は通さない。)
  if ('serviceWorker' in navigator) {
    if (location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    } else {
      navigator.serviceWorker.getRegistrations()
        .then((rs) => rs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
  }

  state.today = new Date();
  state.viewYear = state.today.getFullYear();
  state.viewMonth = state.today.getMonth();

  Settings.load();
  EventStore.load();
  await Holidays.load();

  renderHolidayBanner();
  renderWeekdayRow();
  bindChrome();
  bindModals();
  bindEventForm();
  render();
  startServerHeartbeat();
}

/* ---------- ローカルサーバーへの死活通知 ---------- */
// 起動用の server.py に、タブ/ウィンドウを閉じたら POST /__bye を送る
// (server.py はそれを受けて数秒後に終了し、コンソール窓も閉じる)。
// 保険として GET /__ping を約60秒ごとに送る(クラッシュ等で /__bye が
// 飛ばなかったとき、5分後にサーバーを片付けるため)。
// 送信先は同一オリジンの localhost のみ。ユーザーデータは一切送らない。
// (GitHub Pages などローカル以外で開いたときは何もしない。)
function startServerHeartbeat() {
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!isLocal || location.protocol === 'file:') return;

  const ping = () => fetch('/__ping', { cache: 'no-store' }).catch(() => {});
  ping();
  setInterval(ping, 60000);

  // pagehide はタブを閉じる/別ページへ遷移する瞬間に確実に発火し、
  // sendBeacon はページ破棄後も送信が保証される。
  window.addEventListener('pagehide', () => {
    try { navigator.sendBeacon('/__bye'); } catch (e) { /* 何もしない */ }
  });
}

/* ---------- 祝日バナー ---------- */
function renderHolidayBanner() {
  const banner = document.getElementById('holiday-banner');
  const text = document.getElementById('holiday-banner-text');
  if (sessionStorage.getItem('oneboard.hideHolidayBanner') === '1') {
    banner.hidden = true;
    return;
  }

  let msg = null;
  if (!Holidays.loaded) {
    msg = '祝日データを読み込めませんでした。ファイルを直接開いた場合は「OneBoard起動.bat」から起動してください。';
  } else {
    const missing = Holidays.missingYears(state.today);
    if (missing.length > 0) {
      msg = `祝日データが不足しています(${missing.join('年・')}年分が未収録)。`
        + 'Claude Code に「祝日データを更新して」と依頼してください。';
    }
  }

  if (msg) {
    text.textContent = msg;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

/* ---------- ヘッダー / ナビゲーション ---------- */
function bindChrome() {
  document.getElementById('prev-month').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('next-month').addEventListener('click', () => shiftMonth(1));
  document.getElementById('cur-month').addEventListener('click', goToday);
  document.getElementById('today-btn').addEventListener('click', goToday);
  document.getElementById('add-event-btn').addEventListener('click', () => {
    openEventModal(null, toYmd(new Date()));
  });
  document.getElementById('holiday-banner-close').addEventListener('click', () => {
    sessionStorage.setItem('oneboard.hideHolidayBanner', '1');
    document.getElementById('holiday-banner').hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTopModal();
  });
}

function shiftMonth(delta) {
  let m = state.viewMonth + delta;
  let y = state.viewYear;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  state.viewMonth = m;
  state.viewYear = y;
  render();
}

function goToday() {
  const now = new Date();
  state.viewYear = now.getFullYear();
  state.viewMonth = now.getMonth();
  render();
}

/* ---------- カレンダー描画 ---------- */
function renderWeekdayRow() {
  const row = document.getElementById('weekday-row');
  row.innerHTML = '';
  WEEKDAY_JA.forEach((d, i) => {
    const cell = document.createElement('div');
    cell.className = 'weekday';
    if (i === 0) cell.classList.add('sun');
    if (i === 6) cell.classList.add('sat');
    cell.textContent = d;
    row.appendChild(cell);
  });
}

function render() {
  document.getElementById('cur-month').textContent = `${state.viewYear}年${state.viewMonth + 1}月`;

  const first = new Date(state.viewYear, state.viewMonth, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay()); // 週の頭(日曜)まで戻す
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 41); // 6週 = 42日

  state.occ = buildOccurrenceMap(gridStart, gridEnd);

  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const todayStr = toYmd(new Date());
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    grid.appendChild(buildDayCell(d, todayStr));
  }
}

function buildDayCell(d, todayStr) {
  const ymd = toYmd(d);
  const inMonth = d.getMonth() === state.viewMonth;
  const dow = d.getDay();
  const holiday = Holidays.nameOf(ymd);

  const cell = document.createElement('div');
  cell.className = 'day-cell';
  cell.dataset.date = ymd;
  cell.tabIndex = 0;
  cell.setAttribute('role', 'button');
  if (!inMonth) cell.classList.add('other-month');
  if (ymd === todayStr) cell.classList.add('today');
  if (holiday || dow === 0) cell.classList.add('is-sun');
  else if (dow === 6) cell.classList.add('is-sat');

  const head = document.createElement('div');
  head.className = 'day-head';
  const num = document.createElement('span');
  num.className = 'day-num';
  num.textContent = String(d.getDate());
  head.appendChild(num);
  if (holiday) {
    const h = document.createElement('span');
    h.className = 'day-holiday-label';
    h.textContent = holiday;
    head.appendChild(h);
  }
  cell.appendChild(head);

  const list = state.occ.get(ymd) || [];
  const chipWrap = document.createElement('div');
  chipWrap.className = 'chips';
  list.slice(0, MAX_CHIPS_PER_CELL).forEach((ev) => chipWrap.appendChild(buildChip(ev)));
  if (list.length > MAX_CHIPS_PER_CELL) {
    const more = document.createElement('div');
    more.className = 'chip-more';
    more.textContent = `他 ${list.length - MAX_CHIPS_PER_CELL} 件`;
    chipWrap.appendChild(more);
  }
  cell.appendChild(chipWrap);

  cell.addEventListener('click', () => openDayModal(ymd));
  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDayModal(ymd);
    }
  });
  return cell;
}

function buildChip(ev) {
  const chip = document.createElement('div');
  chip.className = `chip chip-${ev.color || 'blue'}`;
  if (ev.recurrence) chip.classList.add('is-repeat');
  const label = !ev.allDay && ev.startTime ? `${ev.startTime} ${ev.title}` : ev.title;
  chip.textContent = label;
  chip.title = label;
  return chip;
}

/* ---------- 日別モーダル ---------- */
function openDayModal(ymd) {
  const d = fromYmd(ymd);
  document.getElementById('day-modal-title').textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAY_JA[d.getDay()]})`;

  const holEl = document.getElementById('day-modal-holiday');
  const holiday = Holidays.nameOf(ymd);
  if (holiday) {
    holEl.textContent = `祝日: ${holiday}`;
    holEl.hidden = false;
  } else {
    holEl.hidden = true;
  }

  const listEl = document.getElementById('day-event-list');
  const emptyEl = document.getElementById('day-empty');
  listEl.innerHTML = '';
  const items = state.occ.get(ymd) || [];
  emptyEl.hidden = items.length > 0;

  items.forEach((ev) => {
    const li = document.createElement('li');
    li.className = `day-event chip-${ev.color || 'blue'}`;

    const main = document.createElement('div');
    main.className = 'day-event-main';
    const t = document.createElement('div');
    t.className = 'day-event-title';
    t.textContent = ev.title;
    main.appendChild(t);

    const meta = document.createElement('div');
    meta.className = 'day-event-meta';
    const bits = [];
    bits.push(ev.allDay ? '終日' : timeRange(ev));
    if (ev.recurrence) bits.push('繰り返し: ' + describeRecurrence(ev.recurrence));
    meta.textContent = bits.join(' ・ ');
    main.appendChild(meta);

    if (ev.note) {
      const note = document.createElement('div');
      note.className = 'day-event-note';
      note.textContent = ev.note;
      main.appendChild(note);
    }

    if (ev.location) {
      const loc = document.createElement('div');
      loc.className = 'day-event-loc';
      loc.textContent = '📍 ' + ev.location + ' ';

      const map = document.createElement('a');
      map.className = 'map-link';
      // クリックしたときだけ、住所を Google マップに渡して新規タブで開く。
      map.href = 'https://www.google.com/maps/search/?api=1&query='
        + encodeURIComponent(ev.location);
      map.target = '_blank';
      map.rel = 'noopener noreferrer';
      map.textContent = '地図で開く';
      loc.appendChild(map);
      main.appendChild(loc);
    }

    // 発駅は未入力なら既定の発駅(最寄り駅)で補う。着駅があれば経路リンクを出す。
    const fromStation = ev.fromStation || Settings.get('homeStation') || '';
    if (fromStation && ev.toStation) {
      const tr = document.createElement('div');
      tr.className = 'day-event-loc';
      tr.textContent = `🚃 ${fromStation} → ${ev.toStation} `;

      const transit = document.createElement('a');
      transit.className = 'map-link';
      // 押したときだけ、発着駅と日時を Yahoo!乗換案内へ渡して新規タブで開く。
      transit.href = buildYahooTransitUrl(
        fromStation, ev.toStation, ymd, ev.allDay ? null : ev.startTime,
      );
      transit.target = '_blank';
      transit.rel = 'noopener noreferrer';
      transit.textContent = '経路を調べる';
      tr.appendChild(transit);
      main.appendChild(tr);
    }

    if (ev.routeMemo) {
      const route = document.createElement('div');
      route.className = 'day-event-note';
      route.textContent = ev.routeMemo;
      main.appendChild(route);
    }
    li.appendChild(main);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost small';
    edit.textContent = '編集';
    edit.addEventListener('click', () => {
      closeModal('day-modal');
      openEventModal(ev, ymd);
    });
    li.appendChild(edit);

    listEl.appendChild(li);
  });

  document.getElementById('day-add-btn').onclick = () => {
    closeModal('day-modal');
    openEventModal(null, ymd);
  };

  openModal('day-modal');
}

// Yahoo!乗換案内の検索結果 URL を組み立てる。
// リンクを押したときだけ遷移。発駅・着駅・日付・(到着)時刻以外は送らない。
// arriveTime が "HH:MM" なら「到着時刻指定」(type=4)で検索する。
function buildYahooTransitUrl(from, to, ymd, arriveTime) {
  const p = new URLSearchParams();
  p.set('from', from);
  p.set('to', to);
  if (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const [y, m, d] = ymd.split('-').map(Number);
    p.set('y', String(y));
    p.set('m', String(m));
    p.set('d', String(d));
  }
  if (arriveTime && /^\d{1,2}:\d{2}$/.test(arriveTime)) {
    const [hh, mm] = arriveTime.split(':');
    p.set('hh', String(Number(hh)));
    p.set('m1', mm.charAt(0));
    p.set('m2', mm.charAt(1));
    p.set('type', '4'); // 到着時刻を指定
  }
  p.set('ticket', 'ic'); // 運賃は IC 優先
  return 'https://transit.yahoo.co.jp/search/result?' + p.toString();
}

// Yahoo!乗換案内などからコピーした経路テキストを1行に要約する。
// 例: "7:12発 → 8:03着 / 51分 / 乗換1回 / ¥660"。抽出できた項目だけ並べる。
function summarizeTransitText(text) {
  const t = (text || '').replace(/\s+/g, ' ');
  const parts = [];

  const dep = t.match(/(\d{1,2}:\d{2})\s*発/) || t.match(/出発\s*[:：]?\s*(\d{1,2}:\d{2})/);
  const arr = t.match(/(\d{1,2}:\d{2})\s*着/) || t.match(/到着\s*[:：]?\s*(\d{1,2}:\d{2})/);
  if (dep && arr) parts.push(`${dep[1]}発 → ${arr[1]}着`);
  else if (dep) parts.push(`${dep[1]}発`);
  else if (arr) parts.push(`${arr[1]}着`);

  // 所要時間: 「51分（乗車43分）」のような総所要を優先。無ければ所要ラベル、最後に最初の時間表現。
  const dur =
    t.match(/(\d+時間\s*\d+分|\d+時間|\d+分)\s*[（(]\s*(?:乗車|うち乗車)/) ||
    t.match(/所要\s*[:：]?\s*(\d+時間\s*\d+分|\d+時間|\d+分)/) ||
    t.match(/(\d+時間\d+分)/);
  if (dur) parts.push(dur[1].replace(/\s+/g, ''));

  const transfer = t.match(/乗(?:り)?換(?:え)?\s*[:：]?\s*(\d+)\s*回/);
  if (transfer) parts.push(`乗換${transfer[1]}回`);

  const fare = t.match(/(?:￥|¥)?\s*([1-9]\d{0,2}(?:,\d{3})+|\d{2,6})\s*円/);
  if (fare) parts.push(`¥${fare[1].replace(/,/g, '')}`);

  return parts.join(' / ');
}

const ROUTE_SUMMARY_PREFIX = '【経路】';

function onFormatRoute() {
  const el = document.getElementById('ev-route');
  // 既存の要約行(先頭の【経路】…)は一度剥がしてから作り直す(繰り返し押しても重複しない)。
  const body = el.value.replace(
    new RegExp(`^${ROUTE_SUMMARY_PREFIX}.*(?:\\r?\\n)?`), '',
  );
  const summary = summarizeTransitText(body);
  if (!summary) {
    alert('整形できる情報が見つかりませんでした。\n'
      + 'Yahoo!乗換案内の検索結果テキストを貼り付けてから押してください。');
    return;
  }
  el.value = body
    ? `${ROUTE_SUMMARY_PREFIX}${summary}\n${body}`
    : `${ROUTE_SUMMARY_PREFIX}${summary}`;
}

function timeRange(ev) {
  if (ev.startTime && ev.endTime) return `${ev.startTime}–${ev.endTime}`;
  if (ev.startTime) return ev.startTime;
  return '時刻未設定';
}

function describeRecurrence(r) {
  if (r.type === 'monthlyDay') return `毎月${r.day}日`;
  if (r.type === 'monthlyNthWeekday') {
    const w = r.week === -1 ? '最終' : `第${r.week}`;
    return `毎月${w}${WEEKDAY_JA[r.weekday]}曜日`;
  }
  return '';
}

/* ---------- 予定フォーム ---------- */
let editingId = null;      // 編集中の予定 id(新規なら null)
let editingOccYmd = null;  // どの出現日から開いたか(この日だけ削除に使用)

// 時刻欄が空のままフォーカスされたときに入れる初期値。
// 現在時刻を切り上げた直近の正時(00分)。例: 11:50 → "12:00"、11:00 ちょうど → "11:00"。
function nextRoundHour() {
  const now = new Date();
  let h = now.getHours();
  if (now.getMinutes() > 0) h += 1;
  return String(h % 24).padStart(2, '0') + ':00';
}

// "HH:MM" の1時間後(分はそのまま)。
function plusOneHour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return String((h + 1) % 24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function bindEventForm() {
  // 毎月N日セレクトを生成
  const dsel = document.getElementById('ev-monthday');
  for (let i = 1; i <= 31; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = String(i);
    dsel.appendChild(o);
  }

  document.getElementById('ev-allday').addEventListener('change', syncFormVisibility);
  document.getElementById('ev-repeat').addEventListener('change', syncFormVisibility);

  // 時刻欄は初期値なし。空のまま操作(時計マークのクリック/フォーカス)したら
  // 直近の正時(00分)を入れておく。終了は開始が入っていればその1時間後。
  const startEl = document.getElementById('ev-start');
  const endEl = document.getElementById('ev-end');
  const seedStart = () => { if (!startEl.value) startEl.value = nextRoundHour(); };
  const seedEnd = () => {
    if (endEl.value) return;
    endEl.value = startEl.value ? plusOneHour(startEl.value) : nextRoundHour();
  };
  ['focus', 'mousedown'].forEach((evt) => {
    startEl.addEventListener(evt, seedStart);
    endEl.addEventListener(evt, seedEnd);
  });

  document.getElementById('ev-route-format').addEventListener('click', onFormatRoute);

  document.getElementById('event-form').addEventListener('submit', onSubmitEvent);
  document.getElementById('ev-delete-btn').addEventListener('click', onDeleteClick);

  // 削除方法モーダル
  document.getElementById('delete-one-btn').addEventListener('click', () => {
    EventStore.addException(editingId, editingOccYmd);
    closeModal('delete-modal');
    closeModal('event-modal');
    render();
  });
  document.getElementById('delete-all-btn').addEventListener('click', () => {
    EventStore.remove(editingId);
    closeModal('delete-modal');
    closeModal('event-modal');
    render();
  });
}

function syncFormVisibility() {
  const allDay = document.getElementById('ev-allday').checked;
  document.getElementById('ev-time-row').hidden = allDay;

  const repeat = document.getElementById('ev-repeat').value;
  document.getElementById('ev-monthlyday-row').hidden = repeat !== 'monthlyDay';
  document.getElementById('ev-nthweekday-row').hidden = repeat !== 'monthlyNthWeekday';
  document.getElementById('ev-repeat-end-row').hidden = repeat === 'none';

  document.getElementById('ev-date-label').textContent = repeat === 'none' ? '日付' : '開始日';
}

function openEventModal(ev, ymd) {
  editingId = ev ? ev.id : null;
  editingOccYmd = ymd || (ev ? ev.date : toYmd(new Date()));

  document.getElementById('event-modal-title').textContent = ev ? '予定を編集' : '予定を追加';
  document.getElementById('ev-title').value = ev ? ev.title : '';
  document.getElementById('ev-date').value = ev ? ev.date : editingOccYmd;
  document.getElementById('ev-allday').checked = ev ? ev.allDay : false;
  document.getElementById('ev-start').value = ev && ev.startTime ? ev.startTime : '';
  document.getElementById('ev-end').value = ev && ev.endTime ? ev.endTime : '';
  document.getElementById('ev-color').value = ev ? ev.color : 'blue';
  document.getElementById('ev-note').value = ev ? ev.note : '';
  document.getElementById('ev-location').value = ev && ev.location ? ev.location : '';
  // 新規は既定の発駅(最寄り駅)を初期表示。編集時は保存済みの値。
  document.getElementById('ev-from').value =
    ev ? (ev.fromStation || '') : (Settings.get('homeStation') || '');
  document.getElementById('ev-to').value = ev && ev.toStation ? ev.toStation : '';
  document.getElementById('ev-route').value = ev && ev.routeMemo ? ev.routeMemo : '';
  document.getElementById('ev-set-home').checked = false;
  document.getElementById('ev-repeat-end').value = ev && ev.recurrenceEnd ? ev.recurrenceEnd : '';

  const repeatSel = document.getElementById('ev-repeat');
  const mdSel = document.getElementById('ev-monthday');
  const nthSel = document.getElementById('ev-nth');
  const wdSel = document.getElementById('ev-weekday');
  if (ev && ev.recurrence && ev.recurrence.type === 'monthlyDay') {
    repeatSel.value = 'monthlyDay';
    mdSel.value = String(ev.recurrence.day);
  } else if (ev && ev.recurrence && ev.recurrence.type === 'monthlyNthWeekday') {
    repeatSel.value = 'monthlyNthWeekday';
    nthSel.value = String(ev.recurrence.week);
    wdSel.value = String(ev.recurrence.weekday);
  } else {
    repeatSel.value = 'none';
    const d = fromYmd(document.getElementById('ev-date').value);
    mdSel.value = String(d.getDate());
    nthSel.value = String(Math.min(5, Math.ceil(d.getDate() / 7)));
    wdSel.value = String(d.getDay());
  }

  const delBtn = document.getElementById('ev-delete-btn');
  delBtn.hidden = !ev;

  syncFormVisibility();
  openModal('event-modal');
  document.getElementById('ev-title').focus();
}

function onSubmitEvent(e) {
  e.preventDefault();
  const allDay = document.getElementById('ev-allday').checked;
  const repeat = document.getElementById('ev-repeat').value;

  let recurrence = null;
  if (repeat === 'monthlyDay') {
    recurrence = { type: 'monthlyDay', day: parseInt(document.getElementById('ev-monthday').value, 10) };
  } else if (repeat === 'monthlyNthWeekday') {
    recurrence = {
      type: 'monthlyNthWeekday',
      week: parseInt(document.getElementById('ev-nth').value, 10),
      weekday: parseInt(document.getElementById('ev-weekday').value, 10),
    };
  }

  const start = document.getElementById('ev-start').value || null;
  const end = document.getElementById('ev-end').value || null;
  if (!allDay && start && end && end < start) {
    alert('終了時刻は開始時刻より後にしてください。');
    return;
  }
  const repeatEnd = document.getElementById('ev-repeat-end').value || null;
  const dateVal = document.getElementById('ev-date').value;
  if (repeatEnd && repeatEnd < dateVal) {
    alert('繰り返しの終了日は開始日以降にしてください。');
    return;
  }

  const fromStation = document.getElementById('ev-from').value.trim();
  if (document.getElementById('ev-set-home').checked && fromStation) {
    Settings.set('homeStation', fromStation);
  }

  const existing = editingId ? EventStore.get(editingId) : null;
  EventStore.upsert({
    id: editingId || undefined,
    title: document.getElementById('ev-title').value,
    date: dateVal,
    allDay,
    startTime: allDay ? null : start,
    endTime: allDay ? null : end,
    color: document.getElementById('ev-color').value,
    note: document.getElementById('ev-note').value,
    location: document.getElementById('ev-location').value,
    fromStation,
    toStation: document.getElementById('ev-to').value,
    routeMemo: document.getElementById('ev-route').value,
    recurrence,
    recurrenceEnd: recurrence ? repeatEnd : null,
    // 繰り返し種別を変えたら除外リストは無意味になるのでリセット
    exceptions: existing && sameRecurrence(existing.recurrence, recurrence) ? existing.exceptions : [],
    linkedTaskId: existing ? existing.linkedTaskId : null,
  });

  closeModal('event-modal');
  render();
}

function sameRecurrence(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function onDeleteClick() {
  const ev = EventStore.get(editingId);
  if (!ev) return;
  if (ev.recurrence) {
    document.getElementById('delete-modal-text').textContent =
      `「${ev.title}」は繰り返し予定です(${describeRecurrence(ev.recurrence)})。削除方法を選んでください。`;
    openModal('delete-modal');
  } else {
    if (confirm(`「${ev.title}」を削除しますか?`)) {
      EventStore.remove(editingId);
      closeModal('event-modal');
      render();
    }
  }
}

/* ---------- モーダル基盤 ---------- */
function bindModals() {
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeModal(ov.id);
    });
  });
}

function openModal(id) {
  document.getElementById(id).hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
  if (!document.querySelector('.modal-overlay:not([hidden])')) {
    document.body.classList.remove('modal-open');
  }
}

function closeTopModal() {
  const open = [...document.querySelectorAll('.modal-overlay:not([hidden])')];
  if (open.length) closeModal(open[open.length - 1].id);
}
