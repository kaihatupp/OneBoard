# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

**OneBoard** は、齋藤オフィスの個人利用向けアプリ群の1つ。カレンダー(予定管理)を起点に、
将来的にタスク管理などを足していく「小さく作って大きく育てる」方針のボード的アプリ。

姉妹アプリ(`gym-training-trend` / VITALtrend(`taiju-app-dev`) / `kintai` / `kougeisha` /
`pures` / `tokumei` / `yotuya`)と技術構成・運用方針を統一している。

## 開発方針・設計制約

- **技術構成: プレーンな HTML / CSS / 素の JavaScript。フレームワーク・npm・ビルドツール不使用。**
- **データ保存: ブラウザの `localStorage` のみ。** サーバー・DB は使わない。
  - PC ⇔ スマホ同期は将来フェーズの検討事項。フェーズ1では対象外(端末内完結)。
- **完全オフライン完結・データ送信一切なし。** `fetch` / `XMLHttpRequest` / `WebSocket` などで
  ユーザーデータを外部へ送るコードを追加しない。
  - 例外: 同梱した静的ファイルの読み込みのみ(`holidays.json` を同一オリジンから `fetch`)。
  - サーバー送信が必要な機能を頼まれたら、実装前にこの制約との矛盾を指摘すること。
- **ホスティング**: 将来的に GitHub Pages(スマホ対応時)。フェーズ1は PC 上での動作確認を優先。

## 起動方法

- `OneBoard起動.bat` をダブルクリック → `py -m http.server 8123` でローカルサーバーを起動し、
  ブラウザで `http://localhost:8123/` を自動オープンする。
  - Service Worker は使わない。万一ほかのローカルアプリの SW が同一オリジンに残っていても、
    起動時に `navigator.serviceWorker` の全登録を解除する(`app.js` の `init()`)。
- `holidays.json` を `fetch` するため、`index.html` を `file://` で直接開くと祝日が表示されない
  (その場合はバナーで bat 起動を促す)。カレンダー機能自体は動作する。
- デスクトップの `OneBoard-app-dev起動.bat` は Claude Code 起動用で別物(`cd` して `claude` を実行するだけ)。

## フェーズ

- **フェーズ1(実装済み): カレンダー機能**
  - 月表示カレンダー(6週固定グリッド、日曜始まり)
  - 祝日表示(内閣府データを `holidays.json` に同梱、祝日・日曜は赤 / 土曜は青)
  - 祝日データの `coveredYears` で「収録済みの年」を管理。起動時に「今年＋来年」が
    そろっているか判定し、不足していれば画面上部にバナー表示(更新は Claude Code に依頼)
  - 予定の登録・編集・削除(タイトル / 日付 / 終日・時刻 / 色 / メモ)
  - 繰り返し予定: 毎月の日付指定(例: 毎月25日) / 第◯曜日指定(例: 第1火曜、最終金曜)
  - 繰り返しの終了日(任意)、繰り返し予定は「この日だけ削除」(除外日)/「すべて削除」に対応
  - 通知機能は未実装(将来フェーズ)
- **将来フェーズ(構想・未着手)**
  - タスク管理機能。重要タスクとカレンダーの連動(イベントに `linkedTaskId` の空フィールドを予約済み)
  - PWA 対応 / GitHub Pages 公開 / スマホ対応 / PC ⇔ スマホ同期
  - 通知

## ファイル構成

```
OneBoard-app-dev/
├── CLAUDE.md          # このファイル
├── index.html          # 画面(カレンダー本体 + 各モーダル)
├── style.css            # スタイル
├── events.js            # データ層: 祝日ローダー / 予定ストア(localStorage) / 繰り返し展開
├── app.js               # 画面: 月グリッド描画・ナビゲーション・予定フォーム・モーダル制御
├── holidays.json        # 祝日データ(内閣府公開データを JSON 化して同梱)
├── OneBoard起動.bat    # ローカルサーバー起動 + ブラウザ自動オープン
├── icon.ico             # アプリアイコン(16〜256px)
└── generate-icon.ps1    # icon.ico の再生成スクリプト(PowerShell)
```

- デスクトップの `OneBoard.lnk`(ショートカット、リポジトリ管理外)は `OneBoard起動.bat` を
  `icon.ico` 付きで起動する。作り直すには:
  ```powershell
  $ws = New-Object -ComObject WScript.Shell
  $l = $ws.CreateShortcut("$env:USERPROFILE\Desktop\OneBoard.lnk")
  $l.TargetPath = "<このフォルダ>\OneBoard起動.bat"
  $l.WorkingDirectory = "<このフォルダ>"
  $l.IconLocation = "<このフォルダ>\icon.ico,0"
  $l.Save()
  ```

## データモデル(localStorage 実キー)

```js
// 予定: localStorage キー "oneboard.events.v1" … Event[]
// Event: {
//   id,                       // UUID
//   title,
//   date,                     // "YYYY-MM-DD"。単発は開催日、繰り返しは開始日(アンカー)
//   allDay,                   // true なら時刻なし
//   startTime, endTime,       // "HH:MM" | null(allDay=false のときのみ)
//   note,
//   color,                    // 'blue'|'green'|'orange'|'red'|'purple'|'gray'
//   recurrence:               // null(単発)
//       | { type:'monthlyDay', day:1..31 }
//       | { type:'monthlyNthWeekday', week:1..5|-1, weekday:0..6 },  // week=-1 は最終
//   recurrenceEnd,            // "YYYY-MM-DD" | null(繰り返しの終了日、任意)
//   exceptions: string[],     // 繰り返しから除外した日("YYYY-MM-DD" の配列)
//   linkedTaskId: null,       // ★将来のタスク連動用の予約フィールド(現状未使用)
//   createdAt, updatedAt
// }
```

- 古い形式のデータは `EventStore.normalize()` が後方互換で補完する(実データを壊さない)。
- 繰り返しの展開は `eventOccurrences()` / `buildOccurrenceMap()` が担当。祝日判定は `Holidays.nameOf()`。

## 祝日データの更新手順(Claude Code 運用)

1. 内閣府「国民の祝日」CSV を取得
   (https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv)
2. `holidays.json` の `holidays` に新年分の `"YYYY-MM-DD": "祝日名"` を追記
3. `coveredYears` に新しい年を追加、`updatedAt` を更新日に変更
4. 起動して上部バナーが消えることを確認
   - 「今年＋来年」が `coveredYears` にそろえばバナーは出ない
   - 現在の同梱範囲: 2024〜2027年

## 個人情報保護の運用ルール

齋藤オフィスの他アプリと同様、開発相談時に実在の個人データをそのまま貼り付けない。
本アプリのデータは常にブラウザ内に留まり、サーバーへは一切送信されない。
