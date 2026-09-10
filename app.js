'use strict';

/* =========================================================================
 * OneBoard - 画面(月表示カレンダー / 予定の登録・編集・削除)
 * データ層は events.js。
 * ======================================================================= */

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
const MAX_CHIPS_PER_CELL = 3;

// localhost 以外(= GitHub Pages などのスマホ版)は「閲覧専用」。
// 予定の入力は PC(localhost)で行い、スマホは配信された内容を見るだけ。
const IS_VIEWER = !['localhost', '127.0.0.1'].includes(location.hostname);

// 方式B「スマホに反映」: localhost + http(= server.py 経由)のときだけ使える。
const CAN_PUBLISH = !IS_VIEWER && location.protocol.startsWith('http');

// 配信データファイル(暗号化済み)。PC が書き出し → data/ に置いて push → スマホが取得。
const PUBLISHED_DATA_URL = 'data/oneboard.enc.json';

// GitHub Pages 上の同じ配信データ(絶対URL)。PC 故障・買い替えで手元にバックアップが
// 無いとき、「GitHub から復元」ボタンでここから直接取得して全置換する(→ 設計制約の例外5)。
const GITHUB_DATA_URL = 'https://kaihatupp.github.io/OneBoard/data/oneboard.enc.json';

// 自動反映(方式B の上に載せる): 予定・設定を変えたらこの時間だけ待って /__publish。
// 連続編集はまとめて 1 回に畳む。
const AUTO_PUBLISH_DELAY_MS = 5000;

// 捕捉インボックス: スマホで「後で PC で入力」メモを貯め、PC が取り込む。
const INBOX_PAYLOAD_KIND = 'oneboard-inbox';
const INBOX_PAYLOAD_VERSION = 1;
const INBOX_ACK_MAX = 200; // PC が「受け取り済み」と覚えておく id の上限(スマホ側の自動消去用)

const state = {
  viewYear: 0,
  viewMonth: 0, // 0-11
  today: new Date(),
  occ: new Map(), // 現在描画中グリッドの Map<"YYYY-MM-DD", Event[]>
};

/* ---------- 同期設定(localStorage) ---------- */
// パスフレーズは PC・スマホの各ブラウザにだけ保存する(サーバーには送らない)。
const SyncPrefs = (() => {
  const KEY = 'oneboard.sync.v1';
  let data = {
    passphrase: '', lastPulledAt: null, lastPublishedAt: null,
    autoPublish: true, // PC: 予定を変えたら自動で「スマホに反映」(既定オン。データ画面で停止可)
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) data = { ...data, ...JSON.parse(raw) };
    } catch (e) {
      console.warn('[OneBoard] 同期設定の読み込みに失敗しました', e);
    }
    return data;
  }

  function get(key) { return data[key]; }

  function set(patch) {
    data = { ...data, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.error('[OneBoard] 同期設定の保存に失敗しました', e);
    }
  }

  return { load, get, set };
})();

/* ---------- 捕捉インボックス(localStorage) ---------- */
// スマホ: 「後で PC で入力」メモをこの端末に貯める(カレンダーには登録しない)。
// PC:   スマホから取り込んだメモをここに置き、予定化 or 完了で消す。
// 中身は端末内のみ。PC へ渡すときだけパスフレーズで暗号化してファイル/コピー。
const InboxStore = (() => {
  const KEY = 'oneboard.inbox.v1';
  let items = [];

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      items = Array.isArray(parsed)
        ? parsed.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string')
        : [];
    } catch (e) {
      console.warn('[OneBoard] インボックスの読み込みに失敗しました', e);
      items = [];
    }
    return items;
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch (e) {
      console.error('[OneBoard] インボックスの保存に失敗しました', e);
    }
  }

  const all = () => items.slice();
  const count = () => items.length;

  function add(text) {
    const t = (text || '').trim();
    if (!t) return null;
    const item = { id: oneboardUid(), text: t, createdAt: new Date().toISOString() };
    items.unshift(item);
    persist();
    return item;
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((x) => x.id !== id);
    if (items.length !== before) persist();
  }

  /** PC: スマホから受け取ったメモを id で重複排除して取り込む。追加件数を返す。 */
  function mergeIncoming(list) {
    let added = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue;
      if (items.some((x) => x.id === raw.id)) continue;
      items.push({
        id: raw.id,
        text: raw.text.trim(),
        createdAt: raw.createdAt || new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      });
      added += 1;
    }
    if (added) {
      items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      persist();
    }
    return added;
  }

  /** スマホ: PC が受け取り済みの id を配信データから受け取ったら、その分を消す。 */
  function dropByIds(ids) {
    const set = new Set(Array.isArray(ids) ? ids : []);
    const before = items.length;
    items = items.filter((x) => !set.has(x.id));
    if (items.length !== before) persist();
    return before - items.length;
  }

  return { load, all, count, add, remove, mergeIncoming, dropByIds };
})();

/* ---------- インボックス受領記録(PC のみ) ---------- */
// PC が取り込んだメモの id を控えておき、次の配信データに載せる。
// スマホはそれを見て「PC に届いた」メモを自動で消す(手動掃除の手間を省く)。
const InboxAck = (() => {
  const KEY = 'oneboard.inboxack.v1';
  let ids = [];

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      ids = Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch (e) {
      ids = [];
    }
    return ids;
  }

  function add(newIds) {
    for (const id of Array.isArray(newIds) ? newIds : []) {
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
    }
    if (ids.length > INBOX_ACK_MAX) ids = ids.slice(ids.length - INBOX_ACK_MAX);
    try {
      localStorage.setItem(KEY, JSON.stringify(ids));
    } catch (e) {
      console.error('[OneBoard] インボックス受領記録の保存に失敗しました', e);
    }
  }

  const list = () => ids.slice();
  return { load, add, list };
})();

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

  if (IS_VIEWER) document.body.classList.add('viewer-mode');

  Settings.load();
  SyncPrefs.load();
  InboxStore.load();
  if (!IS_VIEWER) InboxAck.load();
  EventStore.load();
  await Holidays.load();

  renderHolidayBanner();
  renderWeekdayRow();
  bindChrome();
  bindModals();
  bindEventForm();
  bindDataModal();
  bindInboxModal();
  render();
  updateFreshness();
  updateInboxIndicator();
  startServerHeartbeat();

  // スマホ版は起動時に配信データを取りに行く(取れなければ前回分のまま)。
  if (IS_VIEWER) await pullPublishedData();

  // PC: 未処理の捕捉メモがあれば、開いた時に気づけるよう一覧を出す。
  if (!IS_VIEWER && InboxStore.count() > 0) openInboxModal();
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

/* =========================================================================
 * データの書き出し / 取り込み(フェーズ2b・方式A)
 *
 * PC: 予定・設定をパスフレーズで暗号化して書き出す(ブラウザのダウンロード)。
 *     マサさんが data/oneboard.enc.json として置き、git push でスマホへ配信。
 * スマホ(IS_VIEWER): 起動時に data/oneboard.enc.json を取得 → 復号 → 表示(閲覧専用)。
 * 暗号化は crypto.js(Web Crypto)。パスフレーズは各ブラウザの localStorage のみ。
 * ======================================================================= */

const DATA_PAYLOAD_KIND = 'oneboard-export';
const DATA_PAYLOAD_VERSION = 1;

/* 自動反映の状態(手動「スマホに反映」とも共有) */
let autoPublishTimer = null;   // デバウンス用
let publishInFlight = false;   // 反映中(手動/自動とも)
let publishDirty = false;      // 反映中にさらに変更があった / 反映待ちの変更がある
let autoPublishError = null;   // 直近の反映の失敗理由(ヘッダー表示用)

function bindDataModal() {
  const passEl = document.getElementById('sync-pass');
  passEl.value = SyncPrefs.get('passphrase') || '';
  // パスフレーズを入れ終えたら(フォーカスが外れた / Enter)、スマホは自動で取得する。
  passEl.addEventListener('change', () => {
    SyncPrefs.set({ passphrase: passEl.value.trim() });
    if (IS_VIEWER && passEl.value.trim()) pullPublishedData();
  });

  document.getElementById('data-pull-btn').addEventListener('click', () => {
    SyncPrefs.set({ passphrase: passEl.value.trim() });
    pullPublishedData();
  });

  const publishBtn = document.getElementById('data-publish-btn');
  publishBtn.hidden = !CAN_PUBLISH;
  document.getElementById('data-publish-hint').hidden = !CAN_PUBLISH;
  publishBtn.addEventListener('click', onPublish);
  document.getElementById('data-export-btn').addEventListener('click', onExportData);

  // 自動反映のオン/オフ(PC のみ)
  const autoRow = document.getElementById('data-auto-row');
  const autoEl = document.getElementById('data-auto-publish');
  autoRow.hidden = !CAN_PUBLISH;
  autoEl.checked = SyncPrefs.get('autoPublish') !== false;
  autoEl.addEventListener('change', () => {
    SyncPrefs.set({ autoPublish: autoEl.checked });
    if (autoEl.checked) {
      scheduleAutoPublish(); // 溜まっていた変更をすぐ反映
    } else {
      if (autoPublishTimer) { clearTimeout(autoPublishTimer); autoPublishTimer = null; }
      publishDirty = false; // 自動オフ中は「未反映」表示を持ち越さない
    }
    updateFreshness();
  });

  document.getElementById('data-import').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) onImportData(file);
    e.target.value = ''; // 同じファイルを続けて選べるように
  });
  const pasteBtn = document.getElementById('data-paste-btn');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', () => {
      const ta = document.getElementById('data-paste');
      const text = (ta.value || '').trim();
      if (!text) { setDataStatus('貼り付けたテキストがありません。', 'error'); return; }
      importEnvelopeText(text).then(() => { ta.value = ''; });
    });
  }

  // PC 復元(GitHub から直接取得)。PC のみ。
  const restoreBtn = document.getElementById('data-restore-btn');
  restoreBtn.hidden = !CAN_PUBLISH;
  document.getElementById('data-restore-hint').hidden = !CAN_PUBLISH;
  restoreBtn.addEventListener('click', onRestoreFromGitHub);
}

function setDataStatus(msg, kind) {
  const el = document.getElementById('data-status');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

function buildExportPayload() {
  return {
    kind: DATA_PAYLOAD_KIND,
    version: DATA_PAYLOAD_VERSION,
    publishedAt: new Date().toISOString(),
    events: EventStore.all(),
    settings: { homeStation: Settings.get('homeStation') },
    // タスク(フェーズ3c。completed を含む。taskTemplates は載せない)。後方互換の追加。
    tasks: (typeof TaskStore !== 'undefined') ? TaskStore.all() : [],
    // PC が取り込んだ捕捉メモの id。スマホはこれを見て届いた分を消す。
    inboxAck: IS_VIEWER ? [] : InboxAck.list(),
  };
}

// テキストを .json ファイルとしてダウンロードさせる(実ブラウザでのみ動く)。
function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onExportData() {
  const pass = (document.getElementById('sync-pass').value || '').trim();
  if (!pass) {
    setDataStatus('先にパスフレーズを入力してください。', 'error');
    return;
  }
  SyncPrefs.set({ passphrase: pass });
  try {
    const envelope = await obEncrypt(buildExportPayload(), pass);
    downloadText(envelope, 'oneboard.enc.json');
    setDataStatus('書き出しました。data/oneboard.enc.json として置いて git push してください。', 'ok');
  } catch (e) {
    console.error('[OneBoard] 書き出しに失敗', e);
    setDataStatus('書き出しに失敗しました: ' + e.message, 'error');
  }
}

/* ---------- 方式B: server.py の /__publish へ配信 ---------- */

// 暗号化 → POST /__publish。server.py の応答オブジェクトを返す(throw はしない)。
async function sendPublish(passphrase) {
  const envelope = await obEncrypt(buildExportPayload(), passphrase);
  const res = await fetch('/__publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: envelope,
  });
  return res.json().catch(() => ({ ok: false, message: '応答を解釈できませんでした' }));
}

// 「スマホに反映」ボタン(手動)。
async function onPublish() {
  const pass = (document.getElementById('sync-pass').value || '').trim();
  if (!pass) {
    setDataStatus('先にパスフレーズを入力してください。', 'error');
    return;
  }
  SyncPrefs.set({ passphrase: pass });
  if (autoPublishTimer) { clearTimeout(autoPublishTimer); autoPublishTimer = null; }
  const btn = document.getElementById('data-publish-btn');
  btn.disabled = true;
  publishInFlight = true;
  publishDirty = false;
  autoPublishError = null;
  setDataStatus('スマホに反映中…');
  updateFreshness();
  try {
    const r = await sendPublish(pass);
    if (r.ok) {
      SyncPrefs.set({ lastPublishedAt: r.at || new Date().toISOString() });
      const when = r.at ? fmtStamp(r.at) : fmtStamp(new Date().toISOString());
      setDataStatus(r.pushed === false
        ? `${r.note || '変更なし'}(${when})`
        : `スマホに反映しました(${when})。`, 'ok');
    } else {
      autoPublishError = r.message || '反映に失敗';
      setDataStatus(`反映に失敗(${r.stage || '?'}): ${r.message || ''}`
        + ' —「ファイルに書き出し」で手動 push もできます。', 'error');
    }
  } catch (e) {
    autoPublishError = 'server.py 未接続';
    setDataStatus('server.py に接続できませんでした。OneBoard起動.bat から起動していますか?', 'error');
  } finally {
    publishInFlight = false;
    btn.disabled = false;
    updateFreshness();
    if (publishDirty) scheduleAutoPublish();
  }
}

/* ---------- 自動反映(方式B の上に載せる) ---------- */

function autoPublishEnabled() {
  return CAN_PUBLISH
    && SyncPrefs.get('autoPublish') !== false
    && !!SyncPrefs.get('passphrase');
}

// 予定・設定を変更したら呼ぶ。数秒後にまとめて 1 回だけ /__publish する。
function scheduleAutoPublish() {
  if (!autoPublishEnabled()) return;
  publishDirty = true;
  if (autoPublishTimer) clearTimeout(autoPublishTimer);
  autoPublishTimer = setTimeout(runAutoPublish, AUTO_PUBLISH_DELAY_MS);
  updateFreshness();
}

async function runAutoPublish() {
  autoPublishTimer = null;
  if (!autoPublishEnabled()) return;
  if (publishInFlight) { publishDirty = true; return; }
  publishInFlight = true;
  publishDirty = false;
  updateFreshness();
  try {
    const r = await sendPublish(SyncPrefs.get('passphrase'));
    if (r && r.ok) {
      SyncPrefs.set({ lastPublishedAt: r.at || new Date().toISOString() });
      autoPublishError = null;
    } else {
      autoPublishError = (r && r.message) || '反映に失敗';
    }
  } catch (e) {
    autoPublishError = 'server.py 未接続';
  } finally {
    publishInFlight = false;
    updateFreshness();
    // 反映中にさらに変更が入っていたら、もう一度だけ予約し直す。
    if (publishDirty) scheduleAutoPublish();
  }
}

async function onImportData(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    setDataStatus('ファイルを読めませんでした。', 'error');
    return;
  }
  await importEnvelopeText(text);
}

// PC 復元: GitHub Pages 上の配信データを直接取得して全置換する。
// localhost から github.io への唯一の外部 fetch(→ 設計制約の例外5)。送るデータは無い。
// 復号・種類判定・全置換 + confirm は既存の importEnvelopeText() をそのまま再利用。
async function onRestoreFromGitHub() {
  const pass = (document.getElementById('sync-pass').value || '').trim()
    || SyncPrefs.get('passphrase');
  if (!pass) {
    setDataStatus('先にパスフレーズを入力してください。', 'error');
    return;
  }
  const btn = document.getElementById('data-restore-btn');
  btn.disabled = true;
  setDataStatus('GitHub から配信データを取得中…');
  let text;
  try {
    // no-store でブラウザキャッシュは無視。GitHub の CDN が最大 10 分キャッシュするため、
    // 取り違え防止に時刻クエリを付ける(送信する情報ではない)。
    const res = await fetch(`${GITHUB_DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    setDataStatus(`GitHub から取得できませんでした(${e.message})。`
      + 'オンラインか、公開URLが正しいか確認してください。既存のデータはそのままです。', 'error');
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  await importEnvelopeText(text);
}

// 暗号化テキスト(ファイル or 貼り付け)を復号し、種類に応じて取り込む。
//  - oneboard-export: 予定・設定を全置換(要 confirm)
//  - oneboard-inbox : スマホの捕捉メモを追記(重複は id で除外)
async function importEnvelopeText(text) {
  const pass = (document.getElementById('sync-pass').value || '').trim()
    || SyncPrefs.get('passphrase');
  if (!pass) {
    setDataStatus('先にパスフレーズを入力してください。', 'error');
    return;
  }

  let payload;
  try {
    payload = await obDecrypt(text, pass);
  } catch (e) {
    setDataStatus(e.message, 'error');
    return;
  }

  if (payload && payload.kind === INBOX_PAYLOAD_KIND) {
    // すでに受領済み(処理して消した分を含む)の id は取り込まない。
    // → 同じファイル/テキストを二度取り込んでも復活しない。
    const acked = new Set(InboxAck.list());
    const incoming = (payload.items || []).filter((x) => x && typeof x.id === 'string');
    const fresh = incoming.filter((x) => !acked.has(x.id));
    const added = InboxStore.mergeIncoming(fresh);
    InboxAck.add(incoming.map((x) => x.id));
    updateInboxIndicator();
    if (!document.getElementById('inbox-modal').hidden) renderInboxList();
    setDataStatus(added > 0
      ? `捕捉メモを ${added} 件取り込みました。「あとで入力」から予定にできます。`
      : '捕捉メモに新しいものはありませんでした。', 'ok');
    // 取り込んだ id を配信データに載せて、スマホ側の一覧から消えるようにする。
    if (added > 0) scheduleAutoPublish();
    return;
  }

  if (payload && payload.kind === DATA_PAYLOAD_KIND) {
    const withTasks = Array.isArray(payload.tasks);
    if (!window.confirm(`取り込むと、この端末の予定${withTasks ? '・タスク' : ''}・設定はすべて置き換わります。よろしいですか?`)) {
      return;
    }
    applyPayload(payload);
    render();
    updateFreshness();
    const taskNote = withTasks ? ` / タスク ${payload.tasks.length} 件` : '';
    setDataStatus(`取り込みました(予定 ${EventStore.all().length} 件${taskNote})。`, 'ok');
    return;
  }

  setDataStatus('OneBoard の書き出しファイルではありません。', 'error');
}

// 復号済みペイロードを localStorage に反映する。
function applyPayload(payload) {
  EventStore.replaceAll(Array.isArray(payload.events) ? payload.events : []);
  Settings.replaceAll(payload.settings || {});
  // タスク(フェーズ3c): payload に tasks があるときだけ全置換する。
  // 旧バージョンの配信データ(tasks なし)では端末内のタスクを消さない。
  if (typeof TaskStore !== 'undefined' && Array.isArray(payload.tasks)) {
    TaskStore.replaceAll(payload.tasks);
    if (typeof renderTaskList === 'function') renderTaskList();
  }
  // スマホ: PC が受け取り済みの捕捉メモを一覧から消す。
  if (IS_VIEWER && Array.isArray(payload.inboxAck) && payload.inboxAck.length) {
    if (InboxStore.dropByIds(payload.inboxAck) > 0) {
      updateInboxIndicator();
      if (!document.getElementById('inbox-modal').hidden) renderInboxList();
    }
  }
  SyncPrefs.set({
    lastPulledAt: new Date().toISOString(),
    lastPublishedAt: payload.publishedAt || null,
  });
}

// スマホ版: 配信ファイルを取得して反映する。best-effort(失敗しても前回分を保持)。
async function pullPublishedData() {
  const pass = SyncPrefs.get('passphrase');
  if (!pass) {
    setDataStatus('パスフレーズを入力すると、配信された予定を表示します。', 'error');
    openModal('data-modal');
    updateFreshness();
    return;
  }

  let text;
  try {
    const res = await fetch(PUBLISHED_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    // オフライン or 未配信。前回取り込んだ内容のまま表示する。
    const has = EventStore.all().length > 0;
    setDataStatus(has ? '配信データを取得できませんでした(前回の内容を表示中)。'
      : 'まだ配信データがありません。PC で書き出して push してください。', has ? null : 'error');
    updateFreshness();
    return;
  }

  let payload;
  try {
    payload = await obDecrypt(text, pass);
  } catch (e) {
    setDataStatus(e.message + '(PC と同じパスフレーズか確認してください)', 'error');
    openModal('data-modal');
    updateFreshness();
    return;
  }
  if (payload && payload.kind === DATA_PAYLOAD_KIND) {
    applyPayload(payload);
    render();
    const taskNote = Array.isArray(payload.tasks) ? ` / タスク ${payload.tasks.length} 件` : '';
    setDataStatus(`取得しました(予定 ${EventStore.all().length} 件${taskNote})。`, 'ok');
    closeModal('data-modal');
  }
  updateFreshness();
}

function updateFreshness() {
  const el = document.getElementById('data-freshness');
  el.classList.remove('is-stale');

  if (IS_VIEWER) {
    const pubIso = SyncPrefs.get('lastPublishedAt');
    const pulledIso = SyncPrefs.get('lastPulledAt');
    if (!pubIso && !pulledIso) {
      el.textContent = '未取得';
    } else {
      const stamp = fmtStamp(pubIso || pulledIso);
      el.textContent = navigator.onLine ? `最終更新 ${stamp}` : `オフライン・最終更新 ${stamp}`;
    }
    el.hidden = false;
    return;
  }

  // PC: 自動反映の状態を出す(反映できる環境のときだけ)。
  if (!CAN_PUBLISH) { el.hidden = true; return; }

  if (publishInFlight) {
    el.textContent = 'スマホに反映中…';
    el.hidden = false;
    return;
  }
  if (autoPublishTimer || publishDirty) {
    el.textContent = '未反映の変更あり';
    el.classList.add('is-stale');
    el.hidden = false;
    return;
  }
  if (autoPublishError) {
    el.textContent = `自動反映できず(${autoPublishError})`;
    el.classList.add('is-stale');
    el.hidden = false;
    return;
  }
  const pubIso = SyncPrefs.get('lastPublishedAt');
  if (pubIso) {
    el.textContent = `スマホに反映済み ${fmtStamp(pubIso)}`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function fmtStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '不明';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* =========================================================================
 * 捕捉インボックス(フェーズ2b・A3)
 *
 * スマホ: 「後で PC で入力」メモを端末内に貯める(カレンダーには登録しない)。
 *         「PC へ渡す」で暗号化ファイル/コピー → PC が取り込む。
 * PC:     取り込んだメモを一覧。「予定にする」でフォームに流し込み、
 *         保存 or 完了で消す。取り込んだ id は次の配信データに載せ、
 *         スマホ側の一覧からも自動で消えるようにする。
 * ======================================================================= */

let pendingInboxId = null; // 「予定にする」で開いたフォームの元メモ id

function bindInboxModal() {
  document.getElementById('inbox-btn').addEventListener('click', openInboxModal);

  const addRow = document.getElementById('inbox-add-row');
  const handoffRow = document.getElementById('inbox-handoff-row');
  addRow.hidden = !IS_VIEWER;
  handoffRow.hidden = !IS_VIEWER;

  if (IS_VIEWER) {
    document.getElementById('inbox-add-btn').addEventListener('click', () => {
      const el = document.getElementById('inbox-text');
      const item = InboxStore.add(el.value);
      if (!item) { setInboxStatus('メモを入力してください。', 'error'); return; }
      el.value = '';
      renderInboxList();
      updateInboxIndicator();
      setInboxStatus('追加しました。', 'ok');
    });
    document.getElementById('inbox-export-btn').addEventListener('click', onInboxExport);
    document.getElementById('inbox-copy-btn').addEventListener('click', onInboxCopy);
  }
}

function setInboxStatus(msg, kind) {
  const el = document.getElementById('inbox-status');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

function openInboxModal() {
  renderInboxList();
  setInboxStatus('');
  openModal('inbox-modal');
}

function renderInboxList() {
  const ul = document.getElementById('inbox-list');
  const empty = document.getElementById('inbox-empty');
  ul.innerHTML = '';
  const items = InboxStore.all();
  empty.hidden = items.length > 0;
  document.getElementById('inbox-handoff-row').hidden = !IS_VIEWER || items.length === 0;

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'day-event inbox-item';

    const main = document.createElement('div');
    main.className = 'day-event-main';
    const t = document.createElement('div');
    t.className = 'day-event-note';
    t.textContent = item.text;
    main.appendChild(t);
    const meta = document.createElement('div');
    meta.className = 'day-event-meta';
    meta.textContent = fmtStamp(item.createdAt) + (item.receivedAt ? ' ・ スマホから' : '');
    main.appendChild(meta);
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'inbox-item-actions';
    if (!IS_VIEWER) {
      const mk = document.createElement('button');
      mk.type = 'button';
      mk.className = 'ghost small';
      mk.textContent = '予定にする';
      mk.addEventListener('click', () => {
        closeModal('inbox-modal');
        openEventModalFromInbox(item);
      });
      actions.appendChild(mk);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small';
    del.textContent = IS_VIEWER ? '削除' : '完了';
    del.addEventListener('click', () => {
      InboxStore.remove(item.id);
      renderInboxList();
      updateInboxIndicator();
    });
    actions.appendChild(del);
    li.appendChild(actions);

    ul.appendChild(li);
  }
}

// ヘッダーの 📋 ボタン: スマホは常時表示、PC は未処理があるときだけ。件数バッジ付き。
function updateInboxIndicator() {
  const btn = document.getElementById('inbox-btn');
  const n = InboxStore.count();
  btn.hidden = IS_VIEWER ? false : n === 0;
  btn.dataset.count = n > 0 ? String(n) : '';
  btn.classList.toggle('has-items', n > 0);
  btn.title = IS_VIEWER
    ? 'あとで入力するメモ'
    : (n > 0 ? `未処理の捕捉メモ ${n} 件` : '捕捉メモ');
}

function buildInboxPayload() {
  return {
    kind: INBOX_PAYLOAD_KIND,
    version: INBOX_PAYLOAD_VERSION,
    exportedAt: new Date().toISOString(),
    items: InboxStore.all().map((x) => ({ id: x.id, text: x.text, createdAt: x.createdAt })),
  };
}

async function encryptInboxOrWarn() {
  const pass = SyncPrefs.get('passphrase');
  if (!pass) {
    setInboxStatus('先に「データ」画面でパスフレーズを設定してください。', 'error');
    return null;
  }
  if (InboxStore.count() === 0) {
    setInboxStatus('メモがありません。', 'error');
    return null;
  }
  try {
    return await obEncrypt(buildInboxPayload(), pass);
  } catch (e) {
    setInboxStatus('暗号化に失敗しました: ' + e.message, 'error');
    return null;
  }
}

async function onInboxExport() {
  const envelope = await encryptInboxOrWarn();
  if (!envelope) return;
  downloadText(envelope, 'oneboard-inbox.enc.json');
  setInboxStatus('書き出しました。PC に移して「データ」画面から取り込んでください。', 'ok');
}

async function onInboxCopy() {
  const envelope = await encryptInboxOrWarn();
  if (!envelope) return;
  try {
    await navigator.clipboard.writeText(envelope);
    setInboxStatus('コピーしました。PC の「データ」画面に貼り付けて取り込んでください。', 'ok');
  } catch (e) {
    setInboxStatus('コピーできませんでした。「書き出し」を使ってください。', 'error');
  }
}

// PC: 捕捉メモを予定フォームに流し込む。保存できたら onSubmitEvent 側でメモを消す。
function openEventModalFromInbox(item) {
  openEventModal(null, toYmd(new Date()));
  pendingInboxId = item.id;
  const oneLine = item.text.replace(/\s+/g, ' ').trim();
  document.getElementById('ev-title').value = oneLine.slice(0, 100);
  document.getElementById('ev-note').value = oneLine.length > 100 ? item.text : '';
  document.getElementById('ev-title').focus();
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
  document.getElementById('data-btn').addEventListener('click', () => openModal('data-modal'));
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

  const now = new Date();
  const todayStr = toYmd(now);
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    grid.appendChild(buildDayCell(d, todayStr, now));
  }
}

function buildDayCell(d, todayStr, now) {
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
  list.slice(0, MAX_CHIPS_PER_CELL).forEach((ev) => chipWrap.appendChild(buildChip(ev, ymd, now)));
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

function buildChip(ev, ymd, now) {
  const chip = document.createElement('div');
  chip.className = `chip chip-${ev.color || 'blue'}`;
  if (ev.recurrence) chip.classList.add('is-repeat');
  if (isEventOccurrencePast(ev, ymd, now)) chip.classList.add('event-past');
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
  const now = new Date();

  items.forEach((ev) => {
    const li = document.createElement('li');
    li.className = `day-event chip-${ev.color || 'blue'}`;
    if (isEventOccurrencePast(ev, ymd, now)) li.classList.add('event-past');

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

    // 閲覧専用(スマホ版)では編集ボタンを出さない。
    if (!IS_VIEWER) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'ghost small';
      edit.textContent = '編集';
      edit.addEventListener('click', () => {
        closeModal('day-modal');
        openEventModal(ev, ymd);
      });
      li.appendChild(edit);
    }

    listEl.appendChild(li);
  });

  const dayAdd = document.getElementById('day-add-btn');
  dayAdd.hidden = IS_VIEWER;
  dayAdd.onclick = () => {
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
    scheduleAutoPublish();
  });
  document.getElementById('delete-all-btn').addEventListener('click', () => {
    EventStore.remove(editingId);
    closeModal('delete-modal');
    closeModal('event-modal');
    render();
    scheduleAutoPublish();
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
  if (IS_VIEWER) return; // 閲覧専用では編集フォームを開かない

  pendingInboxId = null; // 通常の追加/編集。捕捉メモ由来なら呼び出し側が後でセットする。
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

  // 捕捉メモから作った予定なら、保存できたのでそのメモを片付ける。
  if (pendingInboxId) {
    InboxStore.remove(pendingInboxId);
    pendingInboxId = null;
    updateInboxIndicator();
  }

  closeModal('event-modal');
  render();
  scheduleAutoPublish();
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
      scheduleAutoPublish();
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
