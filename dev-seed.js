/* =========================================================================
 * OneBoard - 開発用ダミーデータ投入スクリプト
 *
 * 使い方(開発用プロファイルの localhost:8123 で):
 *   1) OneBoard開発用起動.bat で起動
 *   2) F12 で DevTools → Console タブ
 *   3-a) このファイルの中身を全部貼り付けて Enter、または
 *   3-b) 次の 1 行を貼り付けて Enter:
 *        fetch('/dev-seed.js').then(r => r.text()).then(eval)
 *
 * TaskStore / EventStore / Settings を「ダミーデータで全置換」します。
 * 本番プロファイルで実行すると実データが消えるため、確認ダイアログを挟みます。
 * ======================================================================= */
(() => {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) {
    console.warn('[OneBoard dev-seed] ローカル(localhost)でのみ使えます。'
      + '本番・スマホでは実行しないでください。');
    return;
  }
  if (typeof TaskStore === 'undefined' || typeof EventStore === 'undefined') {
    console.warn('[OneBoard dev-seed] OneBoard のページで実行してください。');
    return;
  }
  if (!window.confirm(
    'この端末(このプロファイル)の 予定・タスク・設定 を「ダミーデータ」で置き換えます。\n'
    + '開発用プロファイルであることを確認してください。実行しますか?'
  )) {
    console.log('[OneBoard dev-seed] 取り消しました。');
    return;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date();
  const shift = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return toYmd(d); };

  EventStore.replaceAll([
    { id: 'dev-e1', title: '[ダミー] 打ち合わせ', date: toYmd(today), allDay: false,
      startTime: '10:00', endTime: '11:00', color: 'blue', note: 'ダミーデータ' },
    { id: 'dev-e2', title: '[ダミー] 終日メモ', date: shift(2), allDay: true, color: 'green' },
    { id: 'dev-e3', title: '[ダミー] 外出(住所つき)', date: shift(3), allDay: false,
      startTime: '14:00', color: 'orange', location: '東京都千代田区丸の内1-1-1',
      fromStation: 'ダミー駅', toStation: '東京' },
    { id: 'dev-e4', title: '[ダミー] 毎月15日の予定', date: shift(-40), allDay: true,
      color: 'purple', recurrence: { type: 'monthlyDay', day: 15 } },
  ]);

  Settings.replaceAll({ homeStation: 'ダミー駅' });

  TaskStore.replaceAll([
    { id: 'dev-t1', title: '[ダミー] 通常タスク(5日後期限)', due: shift(5), body: 'ダミーの本文。\n複数行。' },
    { id: 'dev-t2', title: '[ダミー] 進行中タスク', inProgress: true, body: '' },
    { id: 'dev-t3', title: '[ダミー] 今日が期限', due: toYmd(today) },
    { id: 'dev-t4', title: '[ダミー] 期限切れ', due: shift(-3) },
    { id: 'dev-t5', title: '[ダミー] 完了済みタスク', completed: true, completedAt: new Date().toISOString() },
    { id: 'dev-t6', title: '[ダミー] 期限なし(後で)', due: null, body: 'いつかやる' },
  ]);

  if (typeof render === 'function') render();
  if (typeof renderTaskList === 'function') renderTaskList();
  console.log('[OneBoard dev-seed] ダミーデータを投入しました: 予定 '
    + EventStore.all().length + ' 件 / タスク ' + TaskStore.all().length + ' 件');
})();
