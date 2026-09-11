'use strict';

/* =========================================================================
 * OneBoard - タスク管理(フェーズ3a: 土台 / 3b: 区分表示 / 3c: 完了機能 + 携帯同期)
 *
 * 現在 Outlook で行っているタスク管理を OneBoard へ段階的に移行中。
 *  - 3a: 別ビュー + データ構造(oneboard.tasks.v1)+ 基本の CRUD
 *  - 3b: 一覧を区分ごとのセクション表示に(進行中 / 期限切れ / 今日 / 明日 /
 *        今週 / 来週 / 今月 / 来月 / 後で)。区分は due から都度自動計算(保存しない)。
 *  - 3c: 完了機能(completed / completedAt。行チェックボックス、最下部に折りたたみの
 *        「完了済み」セクション常設)+ 携帯同期(配信データに tasks を載せる。
 *        スマホは閲覧専用)。
 *  - 3d: 記載パターン(テンプレート)。oneboard.taskTemplates.v1。タスク作成時に本文の雛形を
 *        選んで「本文にコピー」。パターンは**携帯同期の対象外**(配信ペイロードに載せない)。
 *  - 3f: 移動ルール(moveRule)+「今日のタスクを移動」ボタン。今日区分のタスクを
 *        ルールに従って次の期限日へ一括で進める。moveRule は tasks の 1 フィールドなので
 *        携帯同期にそのまま乗る(追加実装なし)。
 * カレンダー連携(3g) はまだ含めない。
 *
 * 保存は localStorage キー "oneboard.tasks.v1" のみ。タスク自体が外部へ送られるのは
 * 3c の配信データ経路だけ(app.js が buildExportPayload() に tasks を載せて暗号化 → publish。
 * カレンダー予定とまったく同じ仕組み。→ 設計制約の例外1・3)。
 *
 * カレンダー側との連携:
 *  - app.js のモーダル基盤(openModal / closeModal / bindModals)
 *  - app.js の同期(applyPayload が payload.tasks を TaskStore.replaceAll、
 *    buildExportPayload が TaskStore.all() を読む、scheduleAutoPublish をタスク変更で呼ぶ)
 *  - app.js の IS_VIEWER(スマホ=閲覧専用)
 *  - events.js の日付ユーティリティ toYmd() / fromYmd()(区分の境界計算に流用)
 * ======================================================================= */

const TASKS_KEY = 'oneboard.tasks.v1';
const TASK_TEMPLATES_KEY = 'oneboard.taskTemplates.v1';
const TASK_VIEW_KEY = 'oneboard.view'; // sessionStorage: 最後に開いていたビュー

function taskUid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* ---------- 移動ルール(フェーズ3f) ---------- *
 * moveRule: null | {
 *   type: 'nextDay' | 'weekly' | 'monthlyDay' | 'interval',
 *   weekday?: 0-6,   // weekly
 *   day?:     1-31,  // monthlyDay
 *   days?:    1-365, // interval
 *   holidayAdjust: 'forward' | 'backward'   // 土日祝に当たったときの調整方向
 * }
 */
const MOVE_RULE_TYPES = ['nextDay', 'weekly', 'monthlyDay', 'interval'];

// type ごとの妥当な既定調整方向。
function defaultHolidayAdjust(type) {
  return type === 'monthlyDay' ? 'backward' : 'forward';
}

// フォーム/保存データから moveRule を正規化(不正なら null)。
function normalizeMoveRule(mr) {
  if (!mr || typeof mr !== 'object' || MOVE_RULE_TYPES.indexOf(mr.type) < 0) return null;
  const type = mr.type;
  const adj = (mr.holidayAdjust === 'forward' || mr.holidayAdjust === 'backward')
    ? mr.holidayAdjust
    : defaultHolidayAdjust(type);
  if (type === 'nextDay') return { type, holidayAdjust: adj };
  if (type === 'weekly') {
    const wd = clampInt(mr.weekday, 0, 6, null);
    return wd === null ? null : { type, weekday: wd, holidayAdjust: adj };
  }
  if (type === 'monthlyDay') {
    const d = clampInt(mr.day, 1, 31, null);
    return d === null ? null : { type, day: d, holidayAdjust: adj };
  }
  const n = clampInt(mr.days, 1, 365, null); // interval
  return n === null ? null : { type, days: n, holidayAdjust: adj };
}

// 移動ルールの短い説明(一覧・フォームのヒント用)。
function describeMoveRule(mr) {
  if (!mr) return '';
  const wd = ['日', '月', '火', '水', '木', '金', '土'];
  const tail = mr.holidayAdjust === 'backward' ? '(土日祝は前の営業日)' : '(土日祝は次の営業日)';
  if (mr.type === 'nextDay') return '翌日へ ' + tail;
  if (mr.type === 'weekly') return `次の${wd[mr.weekday]}曜へ ` + tail;
  if (mr.type === 'monthlyDay') return `翌月${mr.day}日へ ` + tail;
  if (mr.type === 'interval') return `${mr.days}日後へ ` + tail;
  return '';
}

/**
 * moveRule に従って currentDue の次の期限日を返す("YYYY-MM-DD")。
 * isHoliday(ymd) -> bool(省略時は Holidays.nameOf を使う)。土日 + 祝日を「休み」とみなし、
 * holidayAdjust: 'forward' は次の営業日まで +1 日、'backward' は前の営業日まで -1 日。
 */
function computeNextDue(currentDue, moveRule, isHoliday) {
  const mr = normalizeMoveRule(moveRule);
  if (!mr || !/^\d{4}-\d{2}-\d{2}$/.test(currentDue || '')) return currentDue;

  const isHol = typeof isHoliday === 'function'
    ? isHoliday
    : (ymd) => (typeof Holidays !== 'undefined' && !!Holidays.nameOf(ymd));

  const base = fromYmd(currentDue);
  let target;

  if (mr.type === 'nextDay') {
    target = new Date(base);
    target.setDate(target.getDate() + 1);
  } else if (mr.type === 'interval') {
    target = new Date(base);
    target.setDate(target.getDate() + mr.days);
  } else if (mr.type === 'weekly') {
    // 次の指定曜日。currentDue が同じ曜日なら翌週。
    let diff = (mr.weekday - base.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    target = new Date(base);
    target.setDate(target.getDate() + diff);
  } else { // monthlyDay: 翌月の指定日(その月に無ければ月末)
    const y = base.getFullYear();
    const m = base.getMonth() + 1; // 翌月(0-index)
    const lastDay = new Date(y, m + 1, 0).getDate();
    target = new Date(y, m, Math.min(mr.day, lastDay));
  }

  // 土日祝の調整
  const step = mr.holidayAdjust === 'backward' ? -1 : 1;
  for (let guard = 0; guard < 400; guard++) {
    const dow = target.getDay();
    if (dow !== 0 && dow !== 6 && !isHol(toYmd(target))) break;
    target.setDate(target.getDate() + step);
  }
  return toYmd(target);
}

/* ---------- タスクストア(localStorage) ---------- */
const TaskStore = (() => {
  let tasks = [];

  /**
   * タスクの正規化。将来フィールドもここで補完し、古い保存データを壊さない。
   * Task: {
   *   id,
   *   title,          // 件名(自由記述)
   *   due,            // "YYYY-MM-DD" | null(期限日)
   *   inProgress,     // true/false。true なら一覧で赤字表示
   *   completed,      // true/false(既定 false)。true は区分判定の対象外 → 「完了済み」へ
   *   completedAt,    // 完了日時(ISO)| null
   *   moveRule,       // 3f: 一括移動ルール。null または normalizeMoveRule() の形
   *   templateName,   // 3d: タスク作成時に選んだ記載パターン名(自由記載なら null)
   *   body,           // 本文(自由記述)
   *   createdAt, updatedAt
   * }
   */
  function normalize(t) {
    const now = new Date().toISOString();
    const src = t && typeof t === 'object' ? t : {};
    const completed = src.completed === true;
    return {
      id: (typeof src.id === 'string' && src.id) ? src.id : taskUid(),
      title: (src.title || '').trim(),
      due: /^\d{4}-\d{2}-\d{2}$/.test(src.due) ? src.due : null,
      inProgress: src.inProgress === true,
      completed,
      completedAt: completed && typeof src.completedAt === 'string' ? src.completedAt : null,
      moveRule: normalizeMoveRule(src.moveRule),
      templateName: src.templateName ?? null,
      body: typeof src.body === 'string' ? src.body : '',
      createdAt: src.createdAt || now,
      updatedAt: src.updatedAt || now,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(TASKS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      tasks = Array.isArray(parsed) ? parsed.map(normalize) : [];
    } catch (e) {
      console.warn('[OneBoard] タスクの読み込みに失敗しました', e);
      tasks = [];
    }
    return tasks;
  }

  function persist() {
    try {
      localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.error('[OneBoard] タスクの保存に失敗しました', e);
      alert('タスクの保存に失敗しました。ブラウザのストレージ容量をご確認ください。');
    }
  }

  const all = () => tasks.slice();
  const get = (id) => tasks.find((t) => t.id === id) || null;

  function upsert(input) {
    const clean = normalize(input);
    const idx = tasks.findIndex((t) => t.id === clean.id);
    if (idx >= 0) {
      clean.createdAt = tasks[idx].createdAt;
      clean.updatedAt = new Date().toISOString();
      tasks[idx] = clean;
    } else {
      tasks.push(clean);
    }
    persist();
    return clean;
  }

  function remove(id) {
    const before = tasks.length;
    tasks = tasks.filter((t) => t.id !== id);
    if (tasks.length !== before) persist();
  }

  // 完了チェックの ON/OFF。ON で completedAt を記録、OFF で null に戻す。
  function setCompleted(id, value) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    t.completed = value === true;
    t.completedAt = t.completed ? new Date().toISOString() : null;
    t.updatedAt = new Date().toISOString();
    persist();
    return t;
  }

  // 期限日だけ差し替える(一括移動用)。
  function setDue(id, ymd) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    t.due = /^\d{4}-\d{2}-\d{2}$/.test(ymd || '') ? ymd : null;
    t.updatedAt = new Date().toISOString();
    persist();
    return t;
  }

  // 同期用: 配信データ(または取り込みファイル)の tasks で全置換。
  function replaceAll(list) {
    tasks = Array.isArray(list) ? list.map(normalize) : [];
    persist();
    return tasks.length;
  }

  return { load, all, get, upsert, remove, setCompleted, setDue, replaceAll };
})();

/* ---------- 記載パターン(テンプレート)ストア(localStorage) ---------- *
 * Template: { id, name, body, createdAt, updatedAt }
 * タスク作成時に本文の雛形を選んでコピーするためのもの。
 * ★ 携帯同期の対象外(配信ペイロードに載せない。PC ごとにローカル管理)。
 */
const TaskTemplateStore = (() => {
  let items = [];

  function normalize(t) {
    const now = new Date().toISOString();
    const src = t && typeof t === 'object' ? t : {};
    return {
      id: (typeof src.id === 'string' && src.id) ? src.id : ('tpl-' + taskUid()),
      name: (src.name || '').trim(),
      body: typeof src.body === 'string' ? src.body : '',
      createdAt: src.createdAt || now,
      updatedAt: src.updatedAt || now,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(TASK_TEMPLATES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      items = Array.isArray(parsed) ? parsed.map(normalize).filter((x) => x.name) : [];
    } catch (e) {
      console.warn('[OneBoard] 記載パターンの読み込みに失敗しました', e);
      items = [];
    }
    return items;
  }

  function persist() {
    try {
      localStorage.setItem(TASK_TEMPLATES_KEY, JSON.stringify(items));
    } catch (e) {
      console.error('[OneBoard] 記載パターンの保存に失敗しました', e);
      alert('記載パターンの保存に失敗しました。ブラウザのストレージ容量をご確認ください。');
    }
  }

  const all = () => items.slice();
  const get = (id) => items.find((x) => x.id === id) || null;
  const getByName = (name) => items.find((x) => x.name === name) || null;

  function upsert(input) {
    const clean = normalize(input);
    if (!clean.name) return null;
    const idx = items.findIndex((x) => x.id === clean.id);
    if (idx >= 0) {
      clean.createdAt = items[idx].createdAt;
      clean.updatedAt = new Date().toISOString();
      items[idx] = clean;
    } else {
      items.push(clean);
    }
    persist();
    return clean;
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((x) => x.id !== id);
    if (items.length !== before) persist();
  }

  // 開発用(dev-seed.js)/バックアップ復元用に全置換。※ 携帯同期には使わない。
  function replaceAll(list) {
    items = (Array.isArray(list) ? list.map(normalize) : []).filter((x) => x.name);
    persist();
    return items.length;
  }

  return { load, all, get, getByName, upsert, remove, replaceAll };
})();

/* ---------- 並び順 ---------- */

// 件名の先頭が「〇〇」(全角かぎ括弧)なら、その中身を「会社名」として返す。無ければ null。
// 例: 「サンプル建設」入社手続き → "サンプル建設"
function extractCompanyName(title) {
  const m = /^「([^」]+)」/.exec(title || '');
  return m ? m[1] : null;
}

// 「進行中」を先頭に寄せ、あとは 期限日昇順(未設定は末尾)。
// 同じ期限日のグループ内だけ、件名先頭の「会社名」であいうえお順に並べる
// (会社名なしはそのグループの最後にまとめる)。最後の同点処理は作成順。
function sortTasks(list) {
  return list.slice().sort((a, b) => {
    if (a.inProgress !== b.inProgress) return a.inProgress ? -1 : 1;

    const ad = a.due || '9999-99-99';
    const bd = b.due || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;

    // ここから下は「期限日が同じタスク同士」だけ
    const ca = extractCompanyName(a.title);
    const cb = extractCompanyName(b.title);
    if (ca !== cb) {
      if (ca === null) return 1;   // 会社名なしは後ろ
      if (cb === null) return -1;
      const c = ca.localeCompare(cb, 'ja');
      if (c !== 0) return c;
    }
    return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
  });
}

// 完了済みは「完了日時の新しい順」。
function sortCompleted(list) {
  return list.slice().sort((a, b) => {
    const av = a.completedAt || a.updatedAt || '';
    const bv = b.completedAt || b.updatedAt || '';
    if (av !== bv) return av < bv ? 1 : -1;
    return 0;
  });
}

const TASK_WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function formatDue(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  const d = fromYmd(ymd); // events.js の日付ユーティリティ
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${TASK_WEEKDAY_JA[d.getDay()]})`;
}

/* ---------- 区分(バケット)判定 ---------- *
 * Outlook のバケット表示に近い区分。due の値から表示のたびに計算する
 * (タスク自体には区分を保存しない)。週の始まりは月曜(タスク側だけの基準。
 * カレンダーは日曜始まりのまま)。
 */

// 表示順。0 件のセクションは描画時に丸ごと省く。
const TASK_SECTIONS = [
  { key: 'inProgress', label: '進行中', cls: 'is-inprogress' }, // 常に最上段・赤字
  { key: 'overdue', label: '期限切れ' },
  { key: 'today', label: '今日' },
  { key: 'tomorrow', label: '明日' },
  { key: 'thisWeek', label: '今週' },
  { key: 'nextWeek', label: '来週' },
  { key: 'thisMonth', label: '今月' },
  { key: 'nextMonth', label: '来月' },
  { key: 'later', label: '後で' },
];

// きょうを起点に、区分の境界を "YYYY-MM-DD" 文字列で用意する。
function computeTaskBoundaries(base) {
  const now = base || new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // ローカル 0:00

  const shift = (d, days) => {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
  };

  const daysSinceMonday = (today.getDay() + 6) % 7; // 月曜=0 … 日曜=6
  const thisMon = shift(today, -daysSinceMonday);

  return {
    today: toYmd(today),
    tomorrow: toYmd(shift(today, 1)),
    thisSun: toYmd(shift(thisMon, 6)),
    nextMon: toYmd(shift(thisMon, 7)),
    nextSun: toYmd(shift(thisMon, 13)),
    thisMonthLast: toYmd(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    nextMonthLast: toYmd(new Date(today.getFullYear(), today.getMonth() + 2, 0)),
  };
}

// 1 件のタスクがどのセクションに入るか。b = computeTaskBoundaries()
function bucketOf(task, b) {
  if (task.completed === true) return 'completed'; // 通常の区分判定からは除外
  if (task.inProgress === true) return 'inProgress';

  const due = task.due;
  if (!due) return 'later';
  if (due < b.today) return 'overdue';
  if (due === b.today) return 'today';
  if (due === b.tomorrow) return 'tomorrow';
  if (due <= b.thisSun) return 'thisWeek';                 // 明後日〜今週日曜
  if (due >= b.nextMon && due <= b.nextSun) return 'nextWeek';
  if (due <= b.thisMonthLast) return 'thisMonth';          // 来週より後・今月中
  if (due <= b.nextMonthLast) return 'nextMonth';
  return 'later';                                          // 来月より先
}

/* ---------- 起動 ---------- */
document.addEventListener('DOMContentLoaded', initTasks);

function initTasks() {
  TaskStore.load();
  TaskTemplateStore.load();
  bindViewTabs();
  bindTaskForm();
  bindTemplateModal();
  renderTaskList();

  let last = 'calendar';
  try { last = sessionStorage.getItem(TASK_VIEW_KEY) || 'calendar'; } catch (e) { /* 何もしない */ }
  if (last === 'tasks') switchView('tasks');
}

/* ---------- ビュー切り替え ---------- */
function bindViewTabs() {
  document.getElementById('tab-calendar').addEventListener('click', () => switchView('calendar'));
  document.getElementById('tab-tasks').addEventListener('click', () => switchView('tasks'));
}

function switchView(view) {
  const isTasks = view === 'tasks';
  document.getElementById('view-calendar').hidden = isTasks;
  document.getElementById('view-tasks').hidden = !isTasks;

  const tabCal = document.getElementById('tab-calendar');
  const tabTask = document.getElementById('tab-tasks');
  tabCal.classList.toggle('is-active', !isTasks);
  tabTask.classList.toggle('is-active', isTasks);
  tabCal.setAttribute('aria-selected', String(!isTasks));
  tabTask.setAttribute('aria-selected', String(isTasks));

  // カレンダー専用のヘッダー操作(月ナビ・予定追加)はタスク表示中は隠す。
  document.body.classList.toggle('tasks-view', isTasks);

  if (isTasks) renderTaskList();
  try { sessionStorage.setItem(TASK_VIEW_KEY, view); } catch (e) { /* 何もしない */ }
}

/* ---------- 一覧描画(区分セクション + 完了済み) ---------- */
let completedExpanded = false; // 「完了済み」セクションの開閉状態(既定: 折りたたみ)

function renderTaskList() {
  const ul = document.getElementById('task-list');
  const empty = document.getElementById('task-empty');
  ul.innerHTML = '';

  // タスクを区分ごとに振り分け(区分は due から都度計算。タスクには保存しない)。
  const b = computeTaskBoundaries();
  const groups = { completed: [] };
  for (const s of TASK_SECTIONS) groups[s.key] = [];
  for (const t of TaskStore.all()) {
    const k = bucketOf(t, b);
    (groups[k] || (groups[k] = [])).push(t);
  }

  let activeCount = 0;
  for (const s of TASK_SECTIONS) {
    const items = sortTasks(groups[s.key]); // セクション内は 期限日順 → 作成順
    if (items.length === 0) continue;       // 0 件のセクションは丸ごと出さない
    activeCount += items.length;

    const head = document.createElement('li');
    head.className = 'task-section-head';
    if (s.cls) head.classList.add(s.cls);
    head.setAttribute('role', 'presentation');
    head.textContent = `${s.label}（${items.length}）`;
    ul.appendChild(head);

    for (const t of items) ul.appendChild(buildTaskRow(t));
  }

  // 「完了済み」セクションは常設(0 件でも見出しは出す。既定は折りたたみ)。
  renderCompletedSection(ul, sortCompleted(groups.completed));

  empty.hidden = (activeCount + groups.completed.length) > 0;
}

function renderCompletedSection(ul, items) {
  const sep = document.createElement('li');
  sep.className = 'task-list-sep';
  sep.setAttribute('aria-hidden', 'true');
  ul.appendChild(sep);

  const head = document.createElement('li');
  head.className = 'task-section-head completed-head';
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', String(completedExpanded));
  head.textContent = `${completedExpanded ? '▾' : '▸'} 完了済み（${items.length}）`;
  const toggle = () => { completedExpanded = !completedExpanded; renderTaskList(); };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  ul.appendChild(head);

  if (completedExpanded) {
    for (const t of items) ul.appendChild(buildTaskRow(t));
  }
}

// タスク 1 行(3b-2: 件名中心のコンパクト行 + 3c: 完了チェックボックス)。
// 本文プレビューは出さない。行をクリック/タップで #task-modal を開き、そこで全内容を確認・編集する。
// スマホ(IS_VIEWER)ではチェックボックスを出さず、モーダルも閲覧専用。
function buildTaskRow(t) {
  const li = document.createElement('li');
  li.className = 'task-item';
  if (t.inProgress) li.classList.add('is-inprogress');
  if (t.completed) li.classList.add('is-done');
  li.setAttribute('role', 'button');
  li.tabIndex = 0;

  if (!IS_VIEWER) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'task-check';
    check.checked = !!t.completed;
    check.setAttribute('aria-label', t.completed ? '完了を取り消す' : '完了にする');
    // 行クリック(モーダルを開く)には伝播させない。
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      TaskStore.setCompleted(t.id, check.checked);
      if (check.checked) completedExpanded = true; // 入れた直後は「完了済み」を開いて動きが見えるように
      renderTaskList();
      scheduleTaskSync();
    });
    li.appendChild(check);
  }

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = t.title || '(件名なし)';
  title.title = t.title || '(件名なし)'; // 省略されたときにホバーで全文
  li.appendChild(title);

  const bits = [];
  if (t.inProgress) bits.push('進行中');
  if (t.due) bits.push('期限 ' + formatDue(t.due));
  if (t.body) bits.push('📝'); // 本文ありの目印(開くと読める)
  if (normalizeMoveRule(t.moveRule)) bits.push('⇢'); // 移動ルールあり
  if (bits.length) {
    const meta = document.createElement('span');
    meta.className = 'task-meta';
    meta.textContent = bits.join(' ・ ');
    meta.title = normalizeMoveRule(t.moveRule) ? '移動ルール: ' + describeMoveRule(normalizeMoveRule(t.moveRule)) : '';
    li.appendChild(meta);
  }

  const open = () => openTaskModal(t);
  li.addEventListener('click', open);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  return li;
}

// タスク変更を PC の自動反映キューに載せる(app.js の関数。スマホ / 未設定時は no-op)。
function scheduleTaskSync() {
  if (typeof scheduleAutoPublish === 'function') scheduleAutoPublish();
}

/* ---------- タスクフォーム ---------- */
let editingTaskId = null;

function bindTaskForm() {
  document.getElementById('task-add-btn').addEventListener('click', () => openTaskModal(null));
  document.getElementById('task-form').addEventListener('submit', onSubmitTask);
  document.getElementById('task-delete-btn').addEventListener('click', onDeleteTask);
  document.getElementById('task-template-copy').addEventListener('click', onCopyTemplateToBody);

  // 3f: 移動ルール欄
  const mdSel = document.getElementById('task-move-weekday');
  for (let i = 0; i <= 6; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = ['日', '月', '火', '水', '木', '金', '土'][i] + '曜';
    mdSel.appendChild(o);
  }
  const daySel = document.getElementById('task-move-day');
  for (let i = 1; i <= 31; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = i + '日';
    daySel.appendChild(o);
  }
  document.getElementById('task-move-type').addEventListener('change', () => syncMoveRuleVisibility(true));

  // 3f: 一括移動
  document.getElementById('task-move-btn').addEventListener('click', onBulkMove);
  document.getElementById('move-proceed-btn').addEventListener('click', () => {
    closeModal('move-modal');
    const list = pendingBulkMove;
    pendingBulkMove = [];
    doBulkMove(list);
  });
}

// 移動ルールの種類に応じてパラメータ欄・調整欄を出し分ける。
// resetAdjust=true のときは種類の既定調整方向をセットする。
function syncMoveRuleVisibility(resetAdjust) {
  const type = document.getElementById('task-move-type').value;
  document.getElementById('task-move-weekly-row').hidden = type !== 'weekly';
  document.getElementById('task-move-monthday-row').hidden = type !== 'monthlyDay';
  document.getElementById('task-move-interval-row').hidden = type !== 'interval';
  document.getElementById('task-move-holiday-row').hidden = !type;
  document.getElementById('task-move-hint').hidden = !type;
  if (resetAdjust && type) {
    document.getElementById('task-move-holiday').value = defaultHolidayAdjust(type);
  }
}

function fillMoveRuleForm(mr) {
  const r = normalizeMoveRule(mr);
  document.getElementById('task-move-type').value = r ? r.type : '';
  document.getElementById('task-move-weekday').value = String(r && r.type === 'weekly' ? r.weekday : 1);
  document.getElementById('task-move-day').value = String(r && r.type === 'monthlyDay' ? r.day : 25);
  document.getElementById('task-move-days').value = String(r && r.type === 'interval' ? r.days : 7);
  document.getElementById('task-move-holiday').value =
    r ? r.holidayAdjust : defaultHolidayAdjust('nextDay');
  syncMoveRuleVisibility(false);
}

function readMoveRuleFromForm() {
  const type = document.getElementById('task-move-type').value;
  if (!type) return null;
  const mr = { type, holidayAdjust: document.getElementById('task-move-holiday').value };
  if (type === 'weekly') mr.weekday = parseInt(document.getElementById('task-move-weekday').value, 10);
  else if (type === 'monthlyDay') mr.day = parseInt(document.getElementById('task-move-day').value, 10);
  else if (type === 'interval') mr.days = parseInt(document.getElementById('task-move-days').value, 10);
  return normalizeMoveRule(mr);
}

// #task-template に「(自由記載)」+ 登録済みパターン名を並べる。
// current が未登録の名前(パターン削除後など)でも失われないよう option を足す。
function populateTemplateSelect(current) {
  const sel = document.getElementById('task-template');
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '(自由記載)';
  sel.appendChild(opt0);

  const names = TaskTemplateStore.all().map((t) => t.name);
  if (current && !names.includes(current)) names.push(current);
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  sel.value = current || '';
}

// 「本文にコピー」: 選択中パターンの body を本文欄へ。本文が空でなければ上書き確認。
function onCopyTemplateToBody() {
  if (IS_VIEWER) return;
  const name = document.getElementById('task-template').value;
  if (!name) {
    alert('コピーするパターンを選んでください。');
    return;
  }
  const tpl = TaskTemplateStore.getByName(name);
  if (!tpl) {
    alert(`「${name}」は見つかりませんでした(削除された可能性)。`);
    return;
  }
  const bodyEl = document.getElementById('task-body');
  if (bodyEl.value.trim()
      && !window.confirm('本文欄の内容をパターンの雛形で上書きします。よろしいですか?')) {
    return;
  }
  bodyEl.value = tpl.body;
  bodyEl.focus();
}

function openTaskModal(task) {
  // スマホは閲覧専用。新規追加(task なし)は無効、既存タスクは読み取り専用で開く。
  const readOnly = IS_VIEWER;
  if (readOnly && !task) return;

  editingTaskId = task ? task.id : null;
  document.getElementById('task-modal-title').textContent =
    readOnly ? 'タスク' : (task ? 'タスクを編集' : 'タスクを追加');
  document.getElementById('task-title').value = task ? task.title : '';
  document.getElementById('task-due').value = task && task.due ? task.due : '';
  document.getElementById('task-inprogress').checked = task ? task.inProgress : false;
  document.getElementById('task-body').value = task ? task.body : '';
  populateTemplateSelect(task ? task.templateName : '');
  fillMoveRuleForm(task ? task.moveRule : null);

  ['task-title', 'task-due', 'task-inprogress', 'task-body', 'task-template',
    'task-move-type', 'task-move-weekday', 'task-move-day', 'task-move-days', 'task-move-holiday',
  ].forEach((id) => {
    document.getElementById(id).disabled = readOnly;
  });
  document.getElementById('task-delete-btn').hidden = readOnly || !task;
  const submitBtn = document.querySelector('#task-form button[type="submit"]');
  if (submitBtn) submitBtn.hidden = readOnly;

  openModal('task-modal');
  if (!readOnly) document.getElementById('task-title').focus();
}

function onSubmitTask(e) {
  e.preventDefault();
  if (IS_VIEWER) return;
  const title = document.getElementById('task-title').value.trim();
  if (!title) {
    document.getElementById('task-title').focus();
    return;
  }
  const existing = editingTaskId ? TaskStore.get(editingTaskId) : null;
  const wasInProgress = existing ? existing.inProgress === true : false;
  const nextInProgress = document.getElementById('task-inprogress').checked;
  // 完了状態はフォームで触らないので既存値を維持する(= 保存操作単体で完了になることはない)。
  const nextCompleted = existing ? existing.completed : false;
  const becomingCompletedNow = !!existing && !existing.completed && nextCompleted;
  let due = document.getElementById('task-due').value || null;
  // 進行中を解除する操作で、かつ同時に完了になるのでなければ、期限を当日へ戻す
  // (「今日」区分に戻り、移動ルールのサイクルを再開できるようにする)。
  if (wasInProgress && !nextInProgress && !becomingCompletedNow) {
    due = toYmd(new Date());
  }
  TaskStore.upsert({
    id: editingTaskId || undefined,
    title,
    due,
    inProgress: nextInProgress,
    body: document.getElementById('task-body').value,
    completed: nextCompleted,
    completedAt: existing ? existing.completedAt : null,
    // 3d: プルダウンで選んだパターン名(「(自由記載)」なら null)。
    templateName: document.getElementById('task-template').value || null,
    // 3f: 移動ルール(「設定しない」なら null)。
    moveRule: readMoveRuleFromForm(),
  });
  closeModal('task-modal');
  renderTaskList();
  scheduleTaskSync();
}

function onDeleteTask() {
  if (IS_VIEWER || !editingTaskId) return;
  const t = TaskStore.get(editingTaskId);
  if (!t) return;
  if (window.confirm(`「${t.title || '(件名なし)'}」を削除しますか?`)) {
    TaskStore.remove(editingTaskId);
    closeModal('task-modal');
    renderTaskList();
    scheduleTaskSync();
  }
}

/* ---------- 一括移動(フェーズ3f) ---------- */
let pendingBulkMove = [];

// 「今日のタスクを移動」: 今日区分のタスクを moveRule に従って次の期限日へ進める。
function onBulkMove() {
  if (IS_VIEWER) return;
  const b = computeTaskBoundaries();
  // bucketOf は completed / inProgress を先に別区分へ回すので、'today' = 未完了・非進行中・期限=今日。
  const todays = TaskStore.all().filter((t) => bucketOf(t, b) === 'today');
  if (todays.length === 0) {
    alert('「今日」のタスクはありません。');
    return;
  }
  const withRule = todays.filter((t) => normalizeMoveRule(t.moveRule));
  const withoutRule = todays.filter((t) => !normalizeMoveRule(t.moveRule));

  if (withoutRule.length === 0) {
    doBulkMove(withRule);
    return;
  }

  // 移動ルール未設定のタスクを一覧表示してから続行を促す。
  pendingBulkMove = withRule;
  document.getElementById('move-modal-text').textContent =
    `次の ${withoutRule.length} 件は移動ルールが無いため、今日のまま残ります`
    + `（ルール設定済みの ${withRule.length} 件だけを移動します）:`;
  const ul = document.getElementById('move-skip-list');
  ul.innerHTML = '';
  for (const t of withoutRule) {
    const li = document.createElement('li');
    li.className = 'day-event';
    li.textContent = t.title || '(件名なし)';
    ul.appendChild(li);
  }
  openModal('move-modal');
}

function doBulkMove(list) {
  const isHol = (ymd) => (typeof Holidays !== 'undefined' && !!Holidays.nameOf(ymd));
  let moved = 0;
  for (const t of list || []) {
    const next = computeNextDue(t.due, t.moveRule, isHol);
    if (next && next !== t.due) {
      TaskStore.setDue(t.id, next);
      moved += 1;
    }
  }
  if (moved > 0) {
    renderTaskList();
    scheduleTaskSync();
  }
  alert(moved > 0
    ? `${moved} 件のタスクを移動しました。`
    : '移動できるタスクはありませんでした。');
}

/* ---------- 記載パターン(テンプレート)管理モーダル ---------- */
let editingTemplateId = null;

function bindTemplateModal() {
  document.getElementById('template-manage-btn').addEventListener('click', openTemplateModal);
  document.getElementById('template-form').addEventListener('submit', onSubmitTemplate);
  document.getElementById('template-new-btn').addEventListener('click', () => fillTemplateForm(null));
  document.getElementById('template-delete-btn').addEventListener('click', onDeleteTemplate);
}

function openTemplateModal() {
  if (IS_VIEWER) return;
  fillTemplateForm(null);
  renderTemplateList();
  openModal('template-modal');
  document.getElementById('template-name').focus();
}

function fillTemplateForm(tpl) {
  editingTemplateId = tpl ? tpl.id : null;
  document.getElementById('template-form-title').textContent = tpl ? 'パターンを編集' : '新しいパターン';
  document.getElementById('template-name').value = tpl ? tpl.name : '';
  document.getElementById('template-body').value = tpl ? tpl.body : '';
  document.getElementById('template-delete-btn').hidden = !tpl;
}

function renderTemplateList() {
  const ul = document.getElementById('template-list');
  const empty = document.getElementById('template-empty');
  ul.innerHTML = '';
  const list = TaskTemplateStore.all().slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  empty.hidden = list.length > 0;

  for (const tpl of list) {
    const li = document.createElement('li');
    li.className = 'template-item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'template-pick';
    const nm = document.createElement('span');
    nm.className = 'template-name';
    nm.textContent = tpl.name;
    const preview = document.createElement('span');
    preview.className = 'template-preview';
    preview.textContent = tpl.body.replace(/\s+/g, ' ').trim().slice(0, 40);
    main.appendChild(nm);
    main.appendChild(preview);
    main.addEventListener('click', () => fillTemplateForm(tpl));
    li.appendChild(main);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (window.confirm(`パターン「${tpl.name}」を削除しますか?`)) {
        TaskTemplateStore.remove(tpl.id);
        if (editingTemplateId === tpl.id) fillTemplateForm(null);
        renderTemplateList();
      }
    });
    li.appendChild(del);

    ul.appendChild(li);
  }
}

function onSubmitTemplate(e) {
  e.preventDefault();
  if (IS_VIEWER) return;
  const name = document.getElementById('template-name').value.trim();
  if (!name) {
    document.getElementById('template-name').focus();
    return;
  }
  const saved = TaskTemplateStore.upsert({
    id: editingTemplateId || undefined,
    name,
    body: document.getElementById('template-body').value,
  });
  fillTemplateForm(saved); // 保存後は「編集」状態のまま(削除ボタンが出る)
  renderTemplateList();
}

function onDeleteTemplate() {
  if (IS_VIEWER || !editingTemplateId) return;
  const tpl = TaskTemplateStore.get(editingTemplateId);
  if (!tpl) return;
  if (window.confirm(`パターン「${tpl.name}」を削除しますか?`)) {
    TaskTemplateStore.remove(editingTemplateId);
    fillTemplateForm(null);
    renderTemplateList();
  }
}
