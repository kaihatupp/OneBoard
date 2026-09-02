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
  // OneBoard は Service Worker を使わない。別アプリのローカルサーバーと同じ
  // ポート/オリジンで開いた場合に古い SW が残っていると誤表示するため掃除する。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
  }

  state.today = new Date();
  state.viewYear = state.today.getFullYear();
  state.viewMonth = state.today.getMonth();

  EventStore.load();
  await Holidays.load();

  renderHolidayBanner();
  renderWeekdayRow();
  bindChrome();
  bindModals();
  bindEventForm();
  render();
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
  document.getElementById('ev-allday').checked = ev ? ev.allDay : true;
  document.getElementById('ev-start').value = ev && ev.startTime ? ev.startTime : '';
  document.getElementById('ev-end').value = ev && ev.endTime ? ev.endTime : '';
  document.getElementById('ev-color').value = ev ? ev.color : 'blue';
  document.getElementById('ev-note').value = ev ? ev.note : '';
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
