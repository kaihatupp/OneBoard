'use strict';

/* =========================================================================
 * OneBoard - データ層(祝日 / 予定ストア / 繰り返し展開)
 * 保存先は localStorage のみ。外部通信は行わない。
 * ジック層は app.js。
 * ======================================================================= */

/* ---------- 日付ユーティリティ ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
/** Date -> "YYYY-MM-DD"(ローカル時刻基準) */
const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** "YYYY-MM-DD" -> Date(ローカル 0:00) */
const fromYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const sameYmd = (a, b) => toYmd(a) === toYmd(b);
const daysInMonth = (year, month0) => new Date(year, month0 + 1, 0).getDate();

/* ---------- 祝日データ ---------- */
const Holidays = (() => {
  let state = { coveredYears: [], holidays: {}, updatedAt: null, loaded: false, error: null };

  async function load() {
    try {
      const res = await fetch('holidays.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      state = {
        coveredYears: Array.isArray(json.coveredYears) ? json.coveredYears : [],
        holidays: json.holidays && typeof json.holidays === 'object' ? json.holidays : {},
        updatedAt: json.updatedAt || null,
        loaded: true,
        error: null,
      };
    } catch (e) {
      state.loaded = false;
      state.error = e;
    }
    return state;
  }

  /** "YYYY-MM-DD" の祝日名(なければ null) */
  const nameOf = (ymd) => state.holidays[ymd] || null;
  const isYearCovered = (year) => state.coveredYears.includes(year);

  /**
   * 「今年 + 来年」のうち収録されていない年を返す。
   * 空配列なら十分そろっている。
   */
  const missingYears = (baseDate = new Date()) => {
    const y = baseDate.getFullYear();
    return [y, y + 1].filter((yy) => !isYearCovered(yy));
  };

  return {
    load,
    nameOf,
    isYearCovered,
    missingYears,
    get loaded() { return state.loaded; },
    get error() { return state.error; },
    get updatedAt() { return state.updatedAt; },
    get coveredYears() { return state.coveredYears.slice(); },
  };
})();

/* ---------- 設定(localStorage) ---------- */
// 端末内の軽い設定。今は「既定の発駅(最寄り駅)」だけ。
const Settings = (() => {
  const KEY = 'oneboard.settings.v1';
  const DEFAULTS = { homeStation: '新越谷' };
  let data = { ...DEFAULTS };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) data = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
      console.warn('[OneBoard] 設定の読み込みに失敗しました', e);
      data = { ...DEFAULTS };
    }
    return data;
  }

  function get(key) { return data[key]; }

  function set(key, value) {
    data[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.error('[OneBoard] 設定の保存に失敗しました', e);
    }
  }

  return { load, get, set };
})();

/* ---------- 予定ストア ---------- */
function oneboardUid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

const EventStore = (() => {
  const KEY = 'oneboard.events.v1';
  let events = [];

  /**
   * 予定の正規化。将来フィールドもここで補完し、古い保存データを壊さない。
   * イベント構造:
   *   id, title, date("YYYY-MM-DD" = 単発なら開催日 / 繰り返しなら開始日),
   *   allDay, startTime, endTime, note, location,
   *   fromStation, toStation, routeMemo, color,
   *   recurrence: null
   *     | { type:'monthlyDay', day:1..31 }
   *     | { type:'monthlyNthWeekday', week:1..5|-1, weekday:0..6 },
   *   recurrenceEnd: "YYYY-MM-DD" | null,
   *   exceptions: ["YYYY-MM-DD", ...]  // 繰り返しから除外した日,
   *   linkedTaskId: null               // 将来のタスク連動用(現状未使用),
   *   createdAt, updatedAt
   */
  function normalize(ev) {
    const now = new Date().toISOString();
    let recurrence = null;
    if (ev.recurrence && ev.recurrence.type === 'monthlyDay') {
      recurrence = { type: 'monthlyDay', day: clampInt(ev.recurrence.day, 1, 31, 1) };
    } else if (ev.recurrence && ev.recurrence.type === 'monthlyNthWeekday') {
      recurrence = {
        type: 'monthlyNthWeekday',
        week: ev.recurrence.week === -1 ? -1 : clampInt(ev.recurrence.week, 1, 5, 1),
        weekday: clampInt(ev.recurrence.weekday, 0, 6, 0),
      };
    }
    return {
      id: ev.id || oneboardUid(),
      title: (ev.title || '').trim() || '(無題)',
      date: ev.date,
      allDay: ev.allDay !== false,
      startTime: ev.allDay === false ? (ev.startTime || null) : null,
      endTime: ev.allDay === false ? (ev.endTime || null) : null,
      note: ev.note || '',
      location: (ev.location || '').trim(),
      fromStation: (ev.fromStation || '').trim(),
      toStation: (ev.toStation || '').trim(),
      routeMemo: ev.routeMemo || '',
      color: ev.color || 'blue',
      recurrence,
      recurrenceEnd: ev.recurrenceEnd || null,
      exceptions: Array.isArray(ev.exceptions) ? ev.exceptions.slice() : [],
      linkedTaskId: ev.linkedTaskId ?? null,
      createdAt: ev.createdAt || now,
      updatedAt: ev.updatedAt || now,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      events = Array.isArray(parsed) ? parsed.map(normalize) : [];
    } catch (e) {
      console.warn('[OneBoard] 予定データの読み込みに失敗しました', e);
      events = [];
    }
    return events;
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(events));
    } catch (e) {
      console.error('[OneBoard] 予定データの保存に失敗しました', e);
      alert('予定の保存に失敗しました。ブラウザのストレージ容量をご確認ください。');
    }
  }

  const all = () => events;
  const get = (id) => events.find((e) => e.id === id) || null;

  function upsert(input) {
    const clean = normalize(input);
    const idx = events.findIndex((e) => e.id === clean.id);
    if (idx >= 0) {
      clean.createdAt = events[idx].createdAt;
      clean.updatedAt = new Date().toISOString();
      events[idx] = clean;
    } else {
      events.push(clean);
    }
    persist();
    return clean;
  }

  function remove(id) {
    events = events.filter((e) => e.id !== id);
    persist();
  }

  /** 繰り返し予定の特定日だけを除外する */
  function addException(id, ymd) {
    const ev = get(id);
    if (!ev) return;
    if (!ev.exceptions.includes(ymd)) ev.exceptions.push(ymd);
    ev.updatedAt = new Date().toISOString();
    persist();
  }

  return { load, all, get, upsert, remove, addException };
})();

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ---------- 繰り返しの展開 ---------- */

/**
 * 指定年月(month0: 0-11)における「第nth週の weekday 曜日」の Date を返す。
 * nth: 1..5、または -1(最終)。該当が無ければ null。
 */
function nthWeekdayOfMonth(year, month0, weekday, nth) {
  if (nth === -1) {
    const last = new Date(year, month0 + 1, 0);
    const back = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month0, last.getDate() - back);
  }
  const first = new Date(year, month0, 1);
  const forward = (weekday - first.getDay() + 7) % 7;
  const day = 1 + forward + (nth - 1) * 7;
  if (day > daysInMonth(year, month0)) return null;
  return new Date(year, month0, day);
}

/**
 * 1件の予定について、[rangeStart, rangeEnd](いずれも Date・両端含む)に
 * 出現する日付を "YYYY-MM-DD" の配列で返す。exceptions は除外済み。
 */
function eventOccurrences(ev, rangeStart, rangeEnd) {
  const anchor = fromYmd(ev.date);
  const endLimit = ev.recurrenceEnd ? fromYmd(ev.recurrenceEnd) : null;
  const effEnd = endLimit && endLimit < rangeEnd ? endLimit : rangeEnd;
  const out = [];

  if (!ev.recurrence) {
    if (anchor >= rangeStart && anchor <= rangeEnd) out.push(ev.date);
    return dropExceptions(ev, out);
  }

  if (anchor > effEnd) return out;

  const startIter = anchor > rangeStart ? anchor : rangeStart;
  let y = startIter.getFullYear();
  let m = startIter.getMonth();
  const endY = effEnd.getFullYear();
  const endM = effEnd.getMonth();

  while (y < endY || (y === endY && m <= endM)) {
    let d = null;
    if (ev.recurrence.type === 'monthlyDay') {
      if (ev.recurrence.day <= daysInMonth(y, m)) d = new Date(y, m, ev.recurrence.day);
    } else if (ev.recurrence.type === 'monthlyNthWeekday') {
      d = nthWeekdayOfMonth(y, m, ev.recurrence.weekday, ev.recurrence.week);
    }
    if (d && d >= anchor && d >= rangeStart && d <= effEnd) out.push(toYmd(d));
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return dropExceptions(ev, out);
}

function dropExceptions(ev, arr) {
  if (!ev.exceptions || ev.exceptions.length === 0) return arr;
  return arr.filter((s) => !ev.exceptions.includes(s));
}

/**
 * [rangeStart, rangeEnd] の全予定を日付ごとにまとめる。
 * 返り値: Map<"YYYY-MM-DD", Event[]>(各日、時刻順にソート済み)
 */
function buildOccurrenceMap(rangeStart, rangeEnd) {
  const map = new Map();
  for (const ev of EventStore.all()) {
    for (const ymd of eventOccurrences(ev, rangeStart, rangeEnd)) {
      if (!map.has(ymd)) map.set(ymd, []);
      map.get(ymd).push(ev);
    }
  }
  for (const list of map.values()) list.sort(compareEventsForDay);
  return map;
}

function compareEventsForDay(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const at = a.startTime || '';
  const bt = b.startTime || '';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.title.localeCompare(b.title, 'ja');
}
