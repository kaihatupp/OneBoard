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
 * EventStore / Settings / TaskStore / TaskTemplateStore を「ダミーデータで全置換」します。
 * 本番プロファイルで実行すると実データが消えるため、確認ダイアログを挟みます。
 * ======================================================================= */
(() => {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) {
    console.warn('[OneBoard dev-seed] ローカル(localhost)でのみ使えます。'
      + '本番・スマホでは実行しないでください。');
    return;
  }
  if (typeof TaskStore === 'undefined' || typeof EventStore === 'undefined'
      || typeof TaskTemplateStore === 'undefined') {
    console.warn('[OneBoard dev-seed] OneBoard のページで実行してください。');
    return;
  }
  if (!window.confirm(
    'この端末(このプロファイル)の 予定・タスク・記載パターン・設定 を「ダミーデータ」で置き換えます。\n'
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

  TaskTemplateStore.replaceAll([
    { id: 'dev-tpl1', name: '[ダミー]パターンA(入社)',
      body: '入社手続き\n・雇用契約書\n・社会保険 資格取得届\n・（対象者）：\n・（入社日）：' },
    { id: 'dev-tpl2', name: '[ダミー]パターンB(退社)',
      body: '退社手続き\n・離職票\n・社会保険 資格喪失届\n・（対象者）：\n・（退職日）：' },
    { id: 'dev-tpl3', name: '[ダミー]36協定',
      body: '36協定届の作成\n・（協定期間）：\n・（時間外の上限）：\n・（特別条項の有無）：' },
  ]);

  if (typeof render === 'function') render();
  if (typeof renderTaskList === 'function') renderTaskList();
  console.log('[OneBoard dev-seed] ダミーデータを投入しました: 予定 '
    + EventStore.all().length + ' 件 / タスク ' + TaskStore.all().length
    + ' 件 / 記載パターン ' + TaskTemplateStore.all().length + ' 件');
})();
