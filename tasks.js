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
 * 一括移動・移動ルール(3f) / カレンダー連携(3g) はまだ含めない。
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
   *   moveRule,       // ★将来の一括移動用の予約フィールド(現状は常に null)
   *   templateName,   // ★将来のテンプレート用の予約フィールド(現状は常に null)
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

  // 同期用: 配信データ(または取り込みファイル)の tasks で全置換。
  function replaceAll(list) {
    tasks = Array.isArray(list) ? list.map(normalize) : [];
    persist();
    return tasks.length;
  }

  return { load, all, get, upsert, remove, setCompleted, replaceAll };
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
  if (bits.length) {
    const meta = document.createElement('span');
    meta.className = 'task-meta';
    meta.textContent = bits.join(' ・ ');
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

  ['task-title', 'task-due', 'task-inprogress', 'task-body', 'task-template'].forEach((id) => {
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
  TaskStore.upsert({
    id: editingTaskId || undefined,
    title,
    due: document.getElementById('task-due').value || null,
    inProgress: document.getElementById('task-inprogress').checked,
    body: document.getElementById('task-body').value,
    // 完了状態はフォームで触らないので既存値を維持する。
    completed: existing ? existing.completed : false,
    completedAt: existing ? existing.completedAt : null,
    // 3d: プルダウンで選んだパターン名(「(自由記載)」なら null)。
    templateName: document.getElementById('task-template').value || null,
    // 予約フィールド: 今回は常に null。既存値があれば維持する。
    moveRule: existing ? existing.moveRule : null,
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
