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
  - PC ⇔ スマホ同期はフェーズ2bの検討事項。現時点では端末内完結で、PC版
    (`localhost`)とスマホ版(GitHub Pages)は**別々のデータ**(オリジンが違うため)。
  - データ構造(`oneboard.events.v1` / `oneboard.settings.v1`)は同期を見据えて壊さない。
- **完全オフライン完結・自動送信一切なし。** `fetch` / `XMLHttpRequest` / `WebSocket` などで
  ユーザーデータを外部へ自動送信するコードを追加しない。
  - 例外1: 同梱した静的ファイルの読み込みのみ(`holidays.json` を同一オリジンから `fetch`)。
    スマホ版は起動時に配信データ `data/oneboard.enc.json` も同一オリジンから `fetch` する
    (`holidays.json` と同種の読み込み)。中身は AES-GCM 暗号文で、パスフレーズは PC・スマホ
    それぞれのブラウザの `localStorage` にだけ保存され、外部へは出ない。
    起動サーバー(`server.py`)への死活通知 `GET /__ping`(約60秒ごと)と、タブを閉じた
    ときの `POST /__bye`(`sendBeacon`)も同種。いずれも同一オリジンの localhost 宛で
    データは送らず、タブを閉じるとサーバーが自動終了する用途。
  - 例外3(方式B・ユーザー承認済み): PC アプリの「スマホに反映」ボタンを**押したときだけ**、
    暗号化済みの配信データを `POST /__publish`(同一オリジンの localhost)へ送る。
    `server.py` がそれを `data/oneboard.enc.json` に書き、`git commit` + `git push`(この
    リポジトリの `origin` = マサさん自身の GitHub)する。パスフレーズは送らない(暗号化は
    ブラウザ側で完了済み)。自動では走らない。失敗時は「ファイルに書き出し」で手動 push に切替可。
  - 例外2(ユーザー承認済み): 外部サイトへのディープリンク。日別モーダルのリンクを
    **ユーザーが押したときだけ**、必要最小限の項目を URL に載せて新規タブで開く。
    `fetch` は使わずページ遷移のみ。押さない限り送信は発生しない。
    - 「地図で開く」: 「場所(住所)」の文字列を Google マップへ
      (`https://www.google.com/maps/search/?api=1&query=<住所>`)。住所以外は送らない。
    - 「経路を調べる」: 「発駅」「着駅」と、その予定の日付・開始時刻(到着指定=`type=4`)を
      Yahoo!乗換案内へ(`https://transit.yahoo.co.jp/search/result?from=&to=&y=&m=&d=&hh=&m1=&m2=&type=4&ticket=ic`)。
      発着駅・日時以外は送らない。発駅が空なら既定の発駅(`Settings` の `homeStation`)で補う。
  - 上記以外でサーバー送信・外部送信が必要な機能を頼まれたら、実装前にこの制約との矛盾を指摘すること。
- **ホスティング**: スマホ版は GitHub Pages(PWA・端末内完結)。PC版は従来どおり
  `OneBoard起動.bat` → `server.py` のローカル配信。両者はコード共通・データ別。
- **Service Worker**: `https` 配信(GitHub Pages)でのみ登録する(`app.js` の `init()`)。
  キャッシュ対象は**同一オリジンのアプリシェル + `holidays.json` だけ**(`sw.js` の `ASSETS`)。
  `localStorage` には触れず、外部へは何も送らない。`localhost`/`http`/`file:` では登録せず、
  姉妹アプリのローカルサーバーと同一オリジンに残った古い SW を解除する
  (`github.io` では他アプリの SW を消さないよう解除処理を通さない)。
  アプリ資産を変更したら `sw.js` の `CACHE` バージョンを上げること(下記「SW キャッシュ更新手順」)。

## 起動方法

- `OneBoard起動.bat` をダブルクリック → `py server.py 8123`(`http.server` 相当の静的配信)で
  ローカルサーバーを起動し、`http://localhost:8123/` を **Chrome の新しいウィンドウ**で開く
  (`chrome.exe --new-window`。Chrome が既に開いていても必ず別ウィンドウ)。
  - Chrome の実行ファイルは `Program Files` /`Program Files (x86)` /`LocalAppData` の
    既定パス → レジストリ App Paths(HKLM/HKCU)の順で探す。見つからなければ既定ブラウザで開く。
  - **`.bat` / `.ps1` は必ず CRLF 改行で保存する。** LF で保存すると cmd.exe が
    `for /f` やラベル(`:openbrowser`)を含む複雑なスクリプトを誤解釈して壊れる
    (エディタや Write ツールが LF にしがちなので、編集後に改行コードを確認すること)。
  - タブ/ウィンドウを閉じると `app.js` の `startServerHeartbeat()` が `POST /__bye`
    (`navigator.sendBeacon`)を送り、`server.py` が数秒後(`BYE_GRACE`)に自動終了する。
    バッチ実行なのでコンソール窓もそのまま閉じる。すぐ止めたいときは窓を閉じる / Ctrl+C でも可。
    複数タブで開いていれば、閉じた直後に別タブの `GET /__ping` が届いて延命される。
  - 保険として `GET /__ping` を約60秒ごとに送り、5分(`IDLE_TIMEOUT`)途切れたら終了
    (クラッシュ等で `/__bye` が飛ばなかったときの後始末)。バックグラウンドタブの
    タイマー抑制で ping 間隔が延びても切れないよう、間隔に対して余裕を持たせている。
  - 待ち受けは `127.0.0.1` のみ。
  - Service Worker は https でのみ登録(上記「開発方針・設計制約」参照)。localhost では
    使わず、起動時に残存 SW を解除する(`app.js` の `init()`)。
- `holidays.json` を `fetch` するため、`index.html` を `file://` で直接開くと祝日が表示されない
  (その場合はバナーで bat 起動を促す)。カレンダー機能自体は動作する。
- デスクトップの `OneBoard-app-dev起動.bat` は Claude Code 起動用で別物(`cd` して `claude` を実行するだけ)。

## フェーズ

- **フェーズ1(実装済み): カレンダー機能**
  - 月表示カレンダー(6週固定グリッド、日曜始まり)
  - 祝日表示(内閣府データを `holidays.json` に同梱、祝日・日曜は赤 / 土曜は青)
  - 祝日データの `coveredYears` で「収録済みの年」を管理。起動時に「今年＋来年」が
    そろっているか判定し、不足していれば画面上部にバナー表示(更新は Claude Code に依頼)
  - 予定の登録・編集・削除
    (タイトル / 日付 / 終日・時刻 / 色 / 場所(住所) / 発駅・着駅 / 経路・アクセス / メモ)
    - 新規予定は「時刻指定」がデフォルト(終日オフ)。開始・終了とも初期値なし。
      空の時刻欄にフォーカスすると直近の正時(00分)が入る(開始→現在の切り上げ、終了→開始の1時間後)
    - 「場所(住所)」を入れると日別モーダルに「地図で開く」リンクが出る(→ 設計制約の例外2)
    - 「発駅・着駅」を入れると日別モーダルに「経路を調べる」(Yahoo!乗換案内)リンクが出る
      (→ 設計制約の例外2)。発駅の初期値は既定の発駅(`Settings.homeStation`、初期値「新越谷」)。
      フォームの「この発駅を既定にする」で `homeStation` を更新できる。
    - 「経路・アクセス」は端末内メモ(外部送信なし)。改行そのままで日別モーダルに表示。
      「貼り付けを整形」ボタン(`summarizeTransitText()`)で、貼り付けた Yahoo!乗換案内の
      結果から「発着時刻 / 所要 / 乗換 / 運賃」を抽出し、先頭に `【経路】…` の要約行を付ける
      (元テキストは残す。繰り返し押しても要約行は 1 本)。
  - 繰り返し予定: 毎月の日付指定(例: 毎月25日) / 第◯曜日指定(例: 第1火曜、最終金曜)
  - 繰り返しの終了日(任意)、繰り返し予定は「この日だけ削除」(除外日)/「すべて削除」に対応
  - 通知機能は未実装(将来フェーズ)
- **フェーズ2a(実装済み): PWA化・スマホ単体対応**
  - `manifest.webmanifest` + `sw.js` でホーム画面追加・スタンドアロン起動・オフライン表示に対応
  - 機能はフェーズ1と同一(祝日・繰り返し・地図/経路リンクなど流用。新機能なし)
  - スマホ画面向けにレスポンシブ強化(`style.css` の `@media`。7列グリッドは維持したまま
    セル圧縮 / モーダルは本文スクロール+ヘッダー・フッター常時表示 / タップ領域拡大 /
    入力欄 16px で iOS 自動ズーム抑止 / セーフエリア対応)
  - GitHub Pages で公開(下記「GitHub Pages 公開手順」)。PC版とはデータ別・同期なし
  - データ構造(`oneboard.events.v1`)は不変(フェーズ2bの同期を見据えて壊さない)
- **フェーズ2b・方式A 前半(実装済み): 暗号化書き出し + スマホ自動取得・閲覧専用**
  - 使い方の前提: 予定・タスクの入力は原則 PC。スマホは閲覧。「PC が正本 → スマホは鏡」
    (双方向マージ・墓標は不要)。
  - `crypto.js`(Web Crypto。ライブラリ不使用)で PBKDF2(SHA-256, 21万回)→ AES-GCM 256。
    パスフレーズは各ブラウザの `localStorage`(`oneboard.sync.v1`)のみ。
  - ヘッダーの歯車 ⚙ →「データ」モーダル。ボタンは環境で出し分け:
    スマホ =「配信データを取得」/ PC =「スマホに反映」(方式B)+「ファイルに書き出し」(手動用)。
    どちらも「ファイルから取り込み」あり。スマホはパスフレーズを入れ終えると自動で取得し、
    成功したらモーダルを閉じる。
  - スマホ(`IS_VIEWER` = localhost 以外)は起動時に `data/oneboard.enc.json` を fetch →
    復号 → 表示。**閲覧専用**(`body.viewer-mode` で追加・編集・削除UIを隠す)。
    ヘッダーに「最終更新 M/D H:M」/「オフライン…」/「未取得」を表示。
    取得失敗時は前回取り込んだ内容のまま(SW でオフライン閲覧可)。
  - 取り込みは**全置換 + confirm**(PCでもバックアップからの復元に使える)。
  - `data/oneboard.enc.json` は初回登録済み。以降は方式Bのボタンで更新。
  - 稼働確認済み(2026-09-07): PC で予定の追加・編集・削除 → スマホに反映されることを確認。
- **フェーズ2b・方式B(実装済み): 「スマホに反映」ボタン**
  - PC のデータモーダルに「スマホに反映」ボタン(`CAN_PUBLISH` = localhost + http のときのみ表示)。
    暗号化 → `POST /__publish` → `server.py` が `data/oneboard.enc.json` を書いて
    `git add/commit/push`。マサさんの操作は「予定を編集 → ボタン1回」。
  - `server.py`: `_handle_publish()` / `_publish_to_git()`。エンベロープ形式を検証してから書き込み、
    `git` は `_git_lock` で直列化。push 拒否時は `pull --rebase` して 1 回再試行。
  - 「ファイルに書き出し」(ダウンロード)は手動 push 用 / バックアップ用として残す。
  - `git` の認証は既存の Git Credential Manager をそのまま利用(新しいトークン不要)。
- **フェーズ2b・残り(未実装 — 次回の候補)**
  1. **保存するたびの自動反映**: 方式B の上に載せる。予定を保存したら数秒後に自動で
     `/__publish`(デバウンス)。PC で編集 → 何もしなくてもスマホが最新(オンライン時)。
  2. **捕捉インボックス(A3)**: スマホで「後で PC で入力」メモを端末内に記録
     (`oneboard.inbox.v1`。カレンダー未登録)。方式A では取り込みファイルに同梱、
     将来は暗号化 `inbox.json` を PC が自動で拾う(スマホに絞ったトークンが1つ必要)。
  3. **方式C**(GitHub API 直叩き): server.py を使わない配信。方式B で困ったときの代替。
  - 設計整理は artifact「OneBoard データ配信設計」。既存の `oneboard.events.v1` 構造は不変。
- **将来フェーズ(構想・未着手)**
  - タスク管理機能。重要タスクとカレンダーの連動(イベントに `linkedTaskId` の空フィールドを予約済み)
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
├── crypto.js            # 暗号化ユーティリティ(Web Crypto。書き出し/取り込み用)
├── data/oneboard.enc.json # 配信データ(暗号文)。PC が書き出し → push、スマホが取得(gitで管理)
├── server.py            # ローカルサーバー(/__bye /__ping で自動終了 + /__publish で配信データを git push)
├── OneBoard起動.bat    # server.py 起動 + Chrome を新規ウィンドウで開く(CRLF 改行必須)
├── manifest.webmanifest # PWA マニフェスト(相対URL。start_url/scope とも "./")
├── sw.js                # Service Worker(https のみ。アプリシェル + holidays.json。データは network-first)
├── .nojekyll            # GitHub Pages の Jekyll 処理を無効化(空ファイル)
├── icons/               # PWA アイコン(icon-192/512(.png) と *-maskable.png)
├── icon.ico             # デスクトップ/favicon 用アイコン(16〜256px)
├── generate-icon.ps1    # icon.ico の再生成スクリプト(PowerShell。UTF-8 BOM + CRLF で保存)
└── generate-pwa-icons.ps1 # icons/*.png の再生成スクリプト(PowerShell。UTF-8 BOM + CRLF で保存)
```

- **`.ps1` は UTF-8 BOM 付き + CRLF で保存する。** BOM なし UTF-8 だと Windows PowerShell 5.1 が
  日本語コメントを ANSI として誤読し、パースエラーになる(`.bat` の CRLF 必須と同種の注意)。

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
// 設定: localStorage キー "oneboard.settings.v1" … { homeStation }
//   homeStation               // 既定の発駅(最寄り駅)。初期値 "新越谷"。events.js の Settings

// 予定: localStorage キー "oneboard.events.v1" … Event[]
// Event: {
//   id,                       // UUID
//   title,
//   date,                     // "YYYY-MM-DD"。単発は開催日、繰り返しは開始日(アンカー)
//   allDay,                   // true なら時刻なし
//   startTime, endTime,       // "HH:MM" | null(allDay=false のときのみ)
//   note,
//   location,                 // 場所(住所)。"" なら地図リンクなし。押下時のみ Google マップへ
//   fromStation, toStation,   // 発駅 / 着駅。両方あれば「経路を調べる」= Yahoo!乗換案内(押下時のみ)
//                             // 発駅が "" のときは Settings.homeStation で補う
//   routeMemo,                // 経路・アクセス。端末内メモのみ(外部送信なし)
//   color,                    // 'blue'|'green'|'orange'|'red'|'purple'|'gray'
//   recurrence:               // null(単発)
//       | { type:'monthlyDay', day:1..31 }
//       | { type:'monthlyNthWeekday', week:1..5|-1, weekday:0..6 },  // week=-1 は最終
//   recurrenceEnd,            // "YYYY-MM-DD" | null(繰り返しの終了日、任意)
//   exceptions: string[],     // 繰り返しから除外した日("YYYY-MM-DD" の配列)
//   linkedTaskId: null,       // ★将来のタスク連動用の予約フィールド(現状未使用)
//   createdAt, updatedAt
// }

// 同期設定: localStorage キー "oneboard.sync.v1" … app.js の SyncPrefs
//   { passphrase,               // 暗号化パスフレーズ(この端末にだけ保存。外部送信なし)
//     lastPulledAt,             // スマホが最後に取り込んだ時刻(ISO)
//     lastPublishedAt }         // 取り込んだデータの publishedAt(= PC が書き出した時刻)

// 書き出しファイル data/oneboard.enc.json … crypto.js のエンベロープ(暗号文)
//   { f:"oneboard-enc", v:1,
//     kdf:{name:"PBKDF2",hash:"SHA-256",iter,salt(b64)}, cipher:"AES-GCM", iv(b64), ct(b64) }
//   復号後のペイロード:
//   { kind:"oneboard-export", version:1, publishedAt(ISO), events:Event[], settings:{homeStation} }
```

- 古い形式のデータは `EventStore.normalize()` が後方互換で補完する(実データを壊さない)。
- 取り込み時は `EventStore.replaceAll()` / `Settings.replaceAll()` が全置換する(方式Aは一方向のため)。
- 繰り返しの展開は `eventOccurrences()` / `buildOccurrenceMap()` が担当。祝日判定は `Holidays.nameOf()`。

## 祝日データの更新手順(Claude Code 運用)

1. 内閣府「国民の祝日」CSV を取得
   (https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv)
2. `holidays.json` の `holidays` に新年分の `"YYYY-MM-DD": "祝日名"` を追記
3. `coveredYears` に新しい年を追加、`updatedAt` を更新日に変更
4. 起動して上部バナーが消えることを確認
   - 「今年＋来年」が `coveredYears` にそろえばバナーは出ない
   - 現在の同梱範囲: 2024〜2027年

## GitHub Pages 公開(セットアップ済み)

初回セットアップは 2026-09-07 に完了済み:

- リポジトリ: https://github.com/kaihatupp/OneBoard (public)
- 公開URL: https://kaihatupp.github.io/OneBoard/
- Pages Source: `master` ブランチ `/(root)`
- ローカルの `origin` は `https://github.com/kaihatupp/OneBoard.git`(`git push origin master` で反映、数分)

- ブランチは `master`。`main` に揃えたい場合は `git branch -m master main` + GitHub 側の
  Pages ブランチ変更 + `git push -u origin main` が必要。
- `gh` CLI は未インストール。GitHub 側の操作(リポジトリ作成・Pages 設定など)は
  マサさんのブラウザ(Chrome のログイン中セッション)経由で行う。

## SW キャッシュ更新手順

`index.html` / `style.css` / `events.js` / `app.js` / `crypto.js` / アイコン / `holidays.json` を変更したら:

1. `sw.js` の `const CACHE = 'oneboard-vN'` の番号を +1 する(現在 `oneboard-v4`)
   ※ `data/oneboard.enc.json` は precache せず network-first。データ更新でバージョンを上げる必要はない
2. コミット・push(GitHub Pages に反映)
3. スマホ側は、次回オンラインで開いたときに新 SW が入り、その次の起動から新版になる
   (`skipWaiting` + `clients.claim` 済みだが、確実には一度アプリを閉じて開き直す)

- PC版(localhost)は SW を使わないので、この手順は不要(`server.py` が `no-store` 配信)。

## 個人情報保護の運用ルール

齋藤オフィスの他アプリと同様、開発相談時に実在の個人データをそのまま貼り付けない。
本アプリのデータは常にブラウザ内に留まり、サーバーへは一切送信されない。
