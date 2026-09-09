'use strict';

/* =========================================================================
 * OneBoard - タスク管理(フェーズ3a: 土台 / 3b: 区分表示)
 *
 * 現在 Outlook で行っているタスク管理を OneBoard へ段階的に移行中。
 *  - 3a: 別ビュー + データ構造(oneboard.tasks.v1)+ 基本の CRUD
 *  - 3b: 一覧を区分ごとのセクション表示に(進行中 / 期限切れ / 今日 / 明日 /
 *        今週 / 来週 / 今月 / 来月 / 後で)。区分は due から都度自動計算(保存しない)。
 * 携帯同期(3c) / テンプレート(3d) / 一括移動・移動ルール(3f) /
 * カレンダー連携(3g) はまだ含めない。
 *
 * 保存は localStorage キー "oneboard.tasks.v1" のみ。外部送信は一切しない
 * (カレンダー側の設計制約をそのまま踏襲。タスク追加で新たな外部通信は発生しない)。
 *
 * カレンダー(app.js / events.js)の内部には依存しない。共有するのは
 *  - app.js のモーダル基盤(openModal / closeModal。#task-modal は .modal-overlay +
 *    [data-close] なので閉じる操作は app.js の bindModals() が面倒を見る)
 *  - events.js の日付ユーティリティ toYmd() / fromYmd()(区分の境界計算に流用)
 * だけ。
 * ======================================================================= */

const TASKS_KEY = 'oneboard.tasks.v1';
const TASK_VIEW_KEY = 'oneboard.view'; // sessionStorage: 最後に開いていたビュー

function taskUid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
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
   *   moveRule,       // ★将来の一括移動用の予約フィールド(現状は常に null)
   *   templateName,   // ★将来のテンプレート用の予約フィールド(現状は常に null)
   *   body,           // 本文(自由記述)
   *   createdAt, updatedAt
   * }
   */
  function normalize(t) {
    const now = new Date().toISOString();
    const src = t && typeof t === 'object' ? t : {};
    return {
      id: (typeof src.id === 'string' && src.id) ? src.id : taskUid(),
      title: (src.title || '').trim(),
      due: /^\d{4}-\d{2}-\d{2}$/.test(src.due) ? src.due : null,
      inProgress: src.inProgress === true,
      moveRule: src.moveRule ?? null,
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

  return { load, all, get, upsert, remove };
})();

/* ---------- 並び順 ---------- */
// フェーズ3a では区分分け・並び替えルールは無し。
// 「進行中」を先頭に寄せ、あとは期限日(未設定は末尾)→ 作成順。
function sortTasks(list) {
  return list.slice().sort((a, b) => {
    if (a.inProgress !== b.inProgress) return a.inProgress ? -1 : 1;
    const ad = a.due || '9999-99-99';
    const bd = b.due || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
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
  bindViewTabs();
  bindTaskForm();
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

/* ---------- 一覧描画(区分セクション) ---------- */
function renderTaskList() {
  const ul = document.getElementById('task-list');
  const empty = document.getElementById('task-empty');
  ul.innerHTML = '';

  // タスクを区分ごとに振り分け(区分は due から都度計算。タスクには保存しない)。
  const b = computeTaskBoundaries();
  const groups = {};
  for (const s of TASK_SECTIONS) groups[s.key] = [];
  for (const t of TaskStore.all()) groups[bucketOf(t, b)].push(t);

  let total = 0;
  for (const s of TASK_SECTIONS) {
    const items = sortTasks(groups[s.key]); // セクション内は 期限日順 → 作成順
    if (items.length === 0) continue;       // 0 件のセクションは丸ごと出さない
    total += items.length;

    const head = document.createElement('li');
    head.className = 'task-section-head';
    if (s.cls) head.classList.add(s.cls);
    head.setAttribute('role', 'presentation');
    head.textContent = `${s.label}（${items.length}）`;
    ul.appendChild(head);

    for (const t of items) ul.appendChild(buildTaskRow(t));
  }

  empty.hidden = total > 0;
}

// タスク 1 行(3a の一覧行のデザインを踏襲)。
function buildTaskRow(t) {
  const li = document.createElement('li');
  li.className = 'task-item';
  if (t.inProgress) li.classList.add('is-inprogress');

  const main = document.createElement('div');
  main.className = 'task-main';

  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = t.title || '(件名なし)';
  main.appendChild(title);

  const bits = [];
  if (t.inProgress) bits.push('進行中');
  if (t.due) bits.push('期限 ' + formatDue(t.due));
  if (bits.length) {
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    meta.textContent = bits.join(' ・ ');
    main.appendChild(meta);
  }

  if (t.body) {
    const body = document.createElement('div');
    body.className = 'task-body';
    body.textContent = t.body;
    main.appendChild(body);
  }
  li.appendChild(main);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ghost small';
  edit.textContent = '編集';
  edit.addEventListener('click', () => openTaskModal(t));
  li.appendChild(edit);

  return li;
}

/* ---------- タスクフォーム ---------- */
let editingTaskId = null;

function bindTaskForm() {
  document.getElementById('task-add-btn').addEventListener('click', () => openTaskModal(null));
  document.getElementById('task-form').addEventListener('submit', onSubmitTask);
  document.getElementById('task-delete-btn').addEventListener('click', onDeleteTask);
}

function openTaskModal(task) {
  editingTaskId = task ? task.id : null;
  document.getElementById('task-modal-title').textContent = task ? 'タスクを編集' : 'タスクを追加';
  document.getElementById('task-title').value = task ? task.title : '';
  document.getElementById('task-due').value = task && task.due ? task.due : '';
  document.getElementById('task-inprogress').checked = task ? task.inProgress : false;
  document.getElementById('task-body').value = task ? task.body : '';
  document.getElementById('task-delete-btn').hidden = !task;

  openModal('task-modal');
  document.getElementById('task-title').focus();
}

function onSubmitTask(e) {
  e.preventDefault();
  const title = document.getElementById('task-title').value.trim();
  if (!title) {
    document.getElementById('task-title').focus();
    return;
  }
  const existing = editingTaskId ? TaskStore.get(editingTaskId) : null;
  TaskStore.upsert({
    id: editingTaskId || undefined,
    title,
    due: document.getElementById('task-due').value || null,
    inProgress: document.getElementById('task-inprogress').checked,
    body: document.getElementById('task-body').value,
    // 予約フィールド: 今回は常に null。既存値があれば維持する。
    moveRule: existing ? existing.moveRule : null,
    templateName: existing ? existing.templateName : null,
  });
  closeModal('task-modal');
  renderTaskList();
}

function onDeleteTask() {
  if (!editingTaskId) return;
  const t = TaskStore.get(editingTaskId);
  if (!t) return;
  if (window.confirm(`「${t.title || '(件名なし)'}」を削除しますか?`)) {
    TaskStore.remove(editingTaskId);
    closeModal('task-modal');
    renderTaskList();
  }
}
