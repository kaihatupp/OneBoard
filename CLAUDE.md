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
  - 例外3(方式B・ユーザー承認済み): PC アプリが暗号化済みの配信データを
    `POST /__publish`(同一オリジンの localhost)へ送る。`server.py` がそれを
    `data/oneboard.enc.json` に書き、`git commit` + `git push`(このリポジトリの
    `origin` = マサさん自身の GitHub)する。パスフレーズは送らない(暗号化はブラウザ側で完了済み)。
    送信のきっかけは 2 つ:
      (a) 「スマホに反映」ボタンを押したとき、
      (b) **自動反映**(既定オン・ユーザー承認済み): 予定・設定を変更してから数秒後
          (`AUTO_PUBLISH_DELAY_MS`、デバウンスで連続編集は 1 回に集約)。
    (b) はデータ画面のチェックボックス(`oneboard.sync.v1` の `autoPublish`)でいつでも止められる。
    どちらも `localhost` + `http`(= server.py 経由)のときだけ。スマホ版(GitHub Pages)・
    `file://` では発生しない。失敗時はヘッダーに「自動反映できず…」と出し、「ファイルに書き出し」で手動 push 可。
  - 例外4(捕捉インボックスの受け渡し・ユーザー承認済み・外部送信なし): スマホの「あとで入力」メモ
    (`oneboard.inbox.v1`)を PC へ渡すとき、パスフレーズで暗号化して **ローカルのファイル
    ダウンロード**(`oneboard-inbox.enc.json`)または **クリップボードへコピー**
    (`navigator.clipboard.writeText`)する。どちらも端末内で完結し、ネットワーク送信はしない。
    PC 側はそのファイル/テキストを「データ」画面で取り込む(復号 → `oneboard.inbox.v1` に追記)。
  - 例外5(GitHub からの復元・ユーザー承認済み): PC の「GitHub から復元」ボタンを
    **押したときだけ**、GitHub Pages 上の配信データ
    `https://kaihatupp.github.io/OneBoard/data/oneboard.enc.json` を `fetch`(GET)する。
    これは `localhost` から `github.io` への**唯一の外部 fetch**。送信するデータは無い
    (URL の `?t=<時刻>` は GitHub の CDN キャッシュ避けの値のみ)。取りに行くのは
    **自分が既に公開している** AES-GCM 暗号文で、復号・全置換は既存の `importEnvelopeText()`
    をそのまま再利用(パスフレーズは PC の `localStorage` / 入力欄。確認ダイアログあり)。
    用途は PC の故障・買い替え時、手元にバックアップファイルが無い状態からの復元。
    GitHub Pages は `Access-Control-Allow-Origin: *` を返すため CORS では弾かれない
    (2026-09-09 確認)。表示条件は `CAN_PUBLISH`(= localhost + http)。
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
  - 開発中の動作確認は `OneBoard開発用起動.bat` を使う(別プロファイル・ダミーデータ。
    下記「本番データの取り扱い(恒久ルール)」)。本番用 `OneBoard起動.bat` は変更しない。
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
  - **終了済み予定の淡色表示**(2026-09-10 追加): 現在時刻を過ぎた予定(発生)を
    月表示のセル内チップ・日別モーダルの両方で淡色化する。
    - 判定 `isEventOccurrencePast(ev, ymd, now)`(events.js): `endTime` があればその日時、
      無く `startTime` のみならその時刻、終日/時刻なしはその日の翌日 0:00 を過ぎたら「終了」。
      繰り返し予定は**発生日ごと**に判定(過去回だけ淡色、未来回は通常)。
    - 見た目: 色分けは保持したまま、共通クラス `.event-past` で一律に強度を落とす
      (`opacity` + `filter: saturate()`。色ごとの薄色は用意しない)。
    - `Event` 構造は不変。描画のたび(`render()` / `openDayModal()`)に現在時刻で都度判定。
      タイマーによる自動更新はしない。
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
- **フェーズ2b・自動反映(実装済み・既定オン): 保存するたびに自動でスマホへ**
  - 方式B の上に載せたデバウンス。予定・設定を変更(追加/編集/削除/この日だけ削除/
    捕捉メモの取り込み)すると `AUTO_PUBLISH_DELAY_MS`(5 秒)後に自動で `sendPublish()`
    = `/__publish`。連続編集はまとめて 1 回。反映中に更なる変更があれば終了後にもう一度。
  - オン/オフはデータ画面のチェックボックス(`oneboard.sync.v1.autoPublish`、既定 `true`)。
    有効条件は `autoPublishEnabled()` = `CAN_PUBLISH` かつ `autoPublish !== false` かつ
    パスフレーズ設定済み。
  - PC のヘッダー `#data-freshness` に状態表示:「未反映の変更あり」/「スマホに反映中…」/
    「スマホに反映済み M/D H:M」/「自動反映できず(理由)」。
  - 手動「スマホに反映」ボタンは残す(即時反映したいとき / 自動オフのとき)。
  - 小さな窓: 変更直後(デバウンス満了前)にタブを閉じると、その 1 回は飛ばない。
    次に何か編集するか、手動ボタンで反映される。
  - 稼働確認済み(2026-09-09): PC で予定作成 → 何もせずスマホに反映されることを確認。
- **フェーズ2b・捕捉インボックス(実装済み・A3 の手動受け渡し版)**
  - スマホ: ヘッダーの 📋 →「あとで入力」モーダルでメモを追加(`oneboard.inbox.v1`、
    `[{id,text,createdAt}]`)。**カレンダーには登録しない**。件数はヘッダーのバッジに出る。
  - スマホ →(手動)→ PC: 「PC へ渡す」でパスフレーズ暗号化 → `oneboard-inbox.enc.json`
    ダウンロード or 「テキストをコピー」(→ 設計制約の例外4。ネットワーク送信なし)。
  - PC: データ画面の「ファイルから取り込み」/「テキストを貼り付け」が `oneboard-export` と
    `oneboard-inbox` を種類判定。`oneboard-inbox` は `oneboard.inbox.v1` に追記(id で重複排除)。
  - PC で気づく仕組み: 未処理メモがあると起動時に「あとで入力」モーダルを自動で開く +
    ヘッダー 📋 バッジ。各メモは「予定にする」(フォームにタイトル流し込み → 保存で消える)
    または「完了」で片付ける。
  - 掃除の自動化: PC が取り込んだ id を `oneboard.inboxack.v1`(直近 200 件)に控え、配信データの
    `inboxAck` に載せる。スマホは次回取得時、その id を持つメモを自動で消す(`InboxStore.dropByIds`)。
  - 稼働確認済み(2026-09-09): スマホでメモ →「テキストをコピー」→ PC で貼り付け取り込み →
    「予定にする」で本入力、までの一連を確認。
- **フェーズ2b・PC 復元(実装済み): 「GitHub から復元」ボタン**
  - PC のデータモーダル(取り込み欄)に「GitHub から復元」(`CAN_PUBLISH` のときのみ表示)。
    `onRestoreFromGitHub()` が `GITHUB_DATA_URL` を `fetch` → テキストを既存の
    `importEnvelopeText()` へ渡す(復号 → `oneboard-export` 判定 → 全置換 + confirm)。
  - 用途: PC 故障・買い替えで手元に `oneboard.enc.json` のバックアップが無いとき、
    公開中の配信データから直接戻す。→ 設計制約の**例外5**(localhost → github.io の外部 fetch)。
  - GitHub CDN は最大 10 分キャッシュ。`?t=<時刻>` で取り違えを避ける。取得失敗時は
    エラー表示のみで既存データには触れない。
  - 稼働確認済み(2026-09-09): localhost → github.io の `fetch`(CORS 通過)・取得データの復号・
    `oneboard-export` 判定までを実ブラウザで確認(全置換は confirm 経由の既存経路)。
    手順は下記「PC 復元手順(買い替え・故障時)」。
- **フェーズ2b・残り(未実装 — 次回の候補)**
  - **方式C**(GitHub API 直叩き): server.py を使わない配信。方式B で困ったときの代替。
    スマホ限定トークンがあれば捕捉インボックスの PC 取り込みも自動化できる(現状は手動受け渡し)。
  - 設計整理は artifact「OneBoard データ配信設計」。既存の `oneboard.events.v1` 構造は不変。
- **フェーズ3a(実装済み): タスク管理の土台**
  - 現在 Outlook で行っているタスク管理を OneBoard へ段階的に移行する第一歩。
    今回は「別ビュー + データ構造 + 基本の CRUD」だけ。
  - ヘッダーに「カレンダー / タスク」タブ(`#tab-calendar` / `#tab-tasks`)。`switchView()` で
    `#view-calendar` ⇄ `#view-tasks` を出し分け(`body.tasks-view` でカレンダー専用の月ナビ・
    「予定を追加」を隠す)。最後に開いていたビューは `sessionStorage` の `oneboard.view` に記憶。
  - タスク画面(`#task-list`)。並びは `sortTasks()` =「進行中を先頭 → 期限日昇順(未設定は末尾)
    →(同じ期限日の中だけ)件名先頭の「会社名」あいうえお順・会社名なしは後ろ → 作成順」。
    「進行中」のタスクは件名・メタを赤字表示。
  - CRUD: `#task-modal`(件名 / 期限日 = `<input type="date">` / 進行中トグル / 本文)。
    追加・編集・削除。閉じる操作は app.js の `bindModals()` が面倒を見る(`.modal-overlay` +
    `[data-close]`)。`openModal` / `closeModal` は app.js の共有関数。
  - **既存のカレンダー(index.html / app.js / style.css / events.js)は変更なし**。
    ロジックは新規 `tasks.js`(app.js の後に読み込み)。index.html はタブ + `<section>` +
    `#task-modal` の追加のみ、style.css はタスク用スタイルの追記のみ。
  - 保存は `localStorage` の `oneboard.tasks.v1` だけ。**外部送信は一切なし**
    (カレンダー側の設計制約をそのまま踏襲。タスク追加で新たな外部通信は発生しない)。
  - 稼働確認済み(2026-09-09): 追加・編集(createdAt 保持 / updatedAt 更新)・削除・
    localStorage 保存・リロード後の復元・ビュー切り替え・カレンダー側への影響なしを実ブラウザで確認。
  - 予約フィールド: `moveRule`(3f 一括移動)/ `templateName`(3d テンプレート)は今回は常に `null`。
    `oneboard.tasks.v1` はフェーズ3c で携帯同期の対象になる予定 → 後方互換を意識し無闇に変更しない。
    将来の `taskTemplates`(パターン)は同期対象にしない方針。
- **フェーズ3b(実装済み): タスクの区分表示**
  - `#task-list` を Outlook のバケット表示に近い区分セクションに分けて表示。
    順序: **進行中 → 期限切れ → 今日 → 明日 → 今週 → 来週 → 今月 → 来月 → 後で**。
    セクション見出しは `<li class="task-section-head">`(件数付き)。カレンダー側は変更なし、
    追加は `tasks.js` と `style.css` のタスク用スタイルのみ。
  - 区分の定義(`bucketOf()` / `computeTaskBoundaries()`。判定は `due` から**毎回計算**。
    タスクには区分を保存しない):
    - 進行中: `inProgress === true`(due に関係なく最上段。件名・メタ・見出しを赤字)
    - 期限切れ: `inProgress !== true` かつ `due < 今日`
    - 今日 / 明日: `due` が今日 / 明日
    - 今週: 明後日〜今週日曜(今日・明日を除く残り)
    - 来週: 翌週の月〜日
    - 今月: 来週より後で今月末まで
    - 来月: 翌月内(来週にかかる分は「来週」優先)
    - 後で: 来月末より先、または `due` が `null`
  - **週の始まりは月曜**(タスク側だけの基準。`daysSinceMonday = (getDay()+6)%7`。
    カレンダーは日曜始まりのまま変更なし)。
  - 各セクションは**該当 0 件なら見出しごと非表示**(「期限切れ」「今日」等も含む)。
    全セクション 0 件のときだけ `#task-empty` を表示。
  - セクション内の並びは 3a と同じ `sortTasks()`(期限日昇順 →〔同じ期限日の中だけ〕会社名あいうえお順
    → 作成順)。会社名は `extractCompanyName(title)`: 件名先頭が `「〇〇」`(全角かぎ括弧)なら中身を
    会社名として扱う(先頭でなければ `null` = 会社名なし。会社名なしは同じ期限日グループの最後)。
    **期限日が違うタスク同士の順序は変えない**(期限日優先は維持)。`sortCompleted()` は対象外。
    別項目としての会社名入力 UI・会社名フィルタは今回含めない(件名内のかっこ書きをそのまま使う)。
  - 境界計算は events.js の `toYmd()` / `fromYmd()` を流用(重複実装なし)。
  - 一覧行(3b-2): **件名中心のコンパクトな 1 行**。本文プレビューは出さない。行に残すのは
    件名(長いと省略・ホバーで全文)+ メタ(進行中 / 期限 M/D(曜)/ 本文ありは 📝)だけ。
    **行全体をクリック/タップ(Enter・Space も可)で `#task-modal` が開き**、本文を含む全内容を
    確認・編集できる(3a の編集モーダルをそのまま流用。閲覧専用モーダルは作らない)。
    行内の「編集」ボタンは廃止。`#task-modal` の本文欄は長文メモ向けに大きめ
    (`rows=14` + `#task-body { min-height:200px; resize:both }`、縦横どちらもドラッグで拡大可)。
    右に広げられるようタスクのモーダルだけ `max-width:720px` + `overflow:auto`。
    スマホでは全幅表示 + 縦ドラッグのみ。
  - 稼働確認済み(2026-09-09): 各区分への振り分け(今日=水曜、月曜始まりの週境界 9/13・9/14・9/20、
    月末境界 9/30・10/1・10/31)、期限切れセクションの表示/非表示切替、0 件セクションの省略、
    全消し時の `#task-empty`、一覧が件名中心になること・行クリックで本文まで確認できることを実ブラウザで確認。
- **フェーズ3c(実装済み): タスクの完了機能 + 携帯同期**
  - **完了機能**:
    - `Task` に `completed`(true/false、既定 false)と `completedAt`(ISO / null)を追加。
    - 一覧の各行(PC のみ)に完了チェックボックス(`.task-check`)。チェックで `completed:true` +
      `completedAt` を記録し `TaskStore.setCompleted()`、即再描画で「完了済み」へ移動。外すと戻る。
    - `bucketOf()` は先頭で `completed === true → 'completed'` を返す(通常の区分判定から除外。
      `inProgress` より優先)。
    - 一覧最下部に区切り線(`.task-list-sep`)+ **「完了済み」セクションを常設**
      (`renderCompletedSection()`。0 件でも見出しは出す)。既定は折りたたみ(`completedExpanded=false`、
      見出しは `▸ 完了済み（N）`)。見出しをタップ/Enter/Space で開閉(`▾`)。開くと完了日時の
      新しい順(`sortCompleted()`)。チェックを入れた直後は自動で開く。
    - 完了済みタスクも件名クリックで `#task-modal`(3a 流用)。完了状態はフォームで触らないので
      編集保存時に既存値を維持。
  - **携帯同期**:
    - 配信ペイロードに `tasks: Task[]`(`completed` 含む)を追加。`taskTemplates` は載せない(方針維持)。
      後方互換: `applyPayload()` は **`payload.tasks` が配列のときだけ**全置換(旧データでは端末内タスクを消さない)。
    - `app.js`: `buildExportPayload()` が `TaskStore.all()` を載せ、`applyPayload()` が
      `TaskStore.replaceAll()` + `renderTaskList()`。`tasks.js` はタスク変更(追加/編集/削除/完了チェック)
      のたびに `scheduleAutoPublish()` を呼ぶ(= 例外3 の自動反映・手動反映の対象に入る)。
    - スマホ(`IS_VIEWER`): タスクタブは表示、区分セクション + 折りたたみ「完了済み」も同じ。
      **チェックボックス・「＋タスクを追加」は非表示**、`#task-modal` は**閲覧専用**
      (フィールド `disabled`、保存・削除ボタン非表示、タイトルは「タスク」)。本文は読める。
    - `server.py` は変更なし(`tasks` は暗号文 `ct` の中。サーバーは見ない)。
    - **PC 復元**(「GitHub から復元」)は `importEnvelopeText()` → `applyPayload()` 経由なので
      `tasks`(completed 含む)も自動的に復元対象。
  - 変更ファイル: `tasks.js` / `app.js`(payload と applyPayload) / `style.css` / `index.html`(取り込み注意文) / `sw.js`(v11)。
  - 稼働確認済み(2026-09-10、ヘッドレス Chrome で 51 チェック): completed の normalize、
    `bucketOf` の completed 除外、完了済みセクションの常設・折りたたみ・件数・新しい順、
    チェック→完了済みへ移動 / 外す→区分へ復帰、編集で completed 維持、
    ペイロード round-trip で completed/completedAt 保持、旧ペイロード(tasks なし)で端末内タスクを消さない、
    スマホ閲覧専用(チェックなし・読み取り専用モーダル)。
- **フェーズ3d(実装済み): 記載パターン(テンプレート)**
  - 「入社A」「退社A」「36協定A」のような**本文の雛形**を用意しておき、タスク作成時に選んで
    本文欄にコピーする。パターンは今後マサさんが少しずつ追加する想定(まずは土台)。
  - `TaskTemplateStore`(localStorage `oneboard.taskTemplates.v1`。
    `Template: { id, name, body, createdAt, updatedAt }`)。一覧・追加・編集・削除。
  - **携帯同期の対象外**。`buildExportPayload()` に載せない(方針どおり。PC ごとにローカル管理)。
  - パターン管理: タスク画面の「パターン管理」ボタン → `#template-modal`(上にフォーム、下に一覧。
    一覧クリックでフォームに読み込み、「新規」でリセット、削除は確認ダイアログ)。
  - タスクフォーム: 「パターン」プルダウン(`#task-template`。`(自由記載)`=`""` + 登録名)+
    「本文にコピー」ボタン(`onCopyTemplateToBody`)。**選ぶだけでは本文は変わらない**。
    「本文にコピー」で `body` を本文欄へ(本文が空でなければ上書き confirm)。コピー後は自由編集。
    選択中の名前は保存時に `templateName` に記録(`(自由記載)` は `null`)。削除済みパターン名も
    option として保持し、保存で失われない。
  - スマホ(`IS_VIEWER`): 「パターン管理」ボタンとタスクフォームの「パターン」欄は非表示。
  - 含めない: `:` で終わる行の個別入力欄化(必要になれば別フェーズ)。
  - 変更ファイル: `tasks.js` / `index.html` / `style.css` / `sw.js`(v12)。app.js は変更なし。
  - 稼働確認済み(2026-09-10、ヘッドレス Chrome で 36 チェック / 開発用プロファイルで統合ロード):
    パターンの追加・編集(id/createdAt 保持)・削除(確認)、一覧の並び、
    プルダウンの中身、「本文にコピー」(空→そのままコピー / 非空→上書き確認)、
    選ぶだけでは本文不変、`templateName` の記録と復元、削除済み名の保持、スマホでの無効化。
- **フェーズ3f(実装済み): 移動ルール + 一括移動ボタン**
  - Outlook で手動でやっている「今日のタスクを翌日等へ動かす」作業をボタン1つに。
  - `moveRule`(タスクのフィールド。`normalizeMoveRule()` で正規化):
    - `nextDay` … 翌日へ
    - `weekly` … `{ weekday: 0-6 }` 次のその曜日へ(同じ曜日なら翌週)
    - `monthlyDay` … `{ day: 1-31 }` 翌月の指定日へ(その月に無ければ月末に丸め)
    - `interval` … `{ days: 1-365 }` 指定日数後へ
    - `holidayAdjust: 'forward' | 'backward'` … 土日祝に当たったときの調整方向。
      既定は `defaultHolidayAdjust(type)` = monthlyDay は `backward`、その他は `forward`。
      フォームでどの type でも手動で逆に変更可。
  - `computeNextDue(currentDue, moveRule, isHoliday)`: type ごとに素の次回日を出し、土日
    (`getDay()` 0/6)+ 祝日(既定は `Holidays.nameOf()`)なら `holidayAdjust` の向きへ 1 日ずつ動かす。
  - タスクフォームに「移動ルール(一括移動用)」欄(既定「設定しない」)。type を選ぶと
    対応するパラメータ欄(曜日 / 日 / 日数)と「土日祝に当たったら」欄が出て、既定の調整方向が入る。
  - タスク画面「今日のタスクを移動」ボタン → 今日区分(`bucketOf` = `'today'` = 未完了・非進行中・
    期限=今日)のタスクを集める。移動ルール未設定のものがあれば `#move-modal` で件名一覧 +
    「今日のまま残ります」+「続行」。未設定が無ければそのまま実行。「続行」で**ルール設定済みのみ**
    `computeNextDue()` で `due` を更新(1件ずつの確認なし)。完了後「N 件移動しました」。
  - 未設定タスクは `due` を変えない(今日区分に残り続ける)。
  - 一覧行の meta に移動ルールありの目印「⇢」(ホバーで説明)。
  - **携帯同期は追加実装なし**(`moveRule` は `tasks[]` の 1 フィールドとして自然に配信・復元される)。
  - `bucketOf()` / `sortTasks()` は変更なし。app.js も変更なし。
  - 変更ファイル: `tasks.js` / `index.html` / `style.css` / `sw.js`(v13)。
  - 稼働確認済み(2026-09-10、ヘッドレス Chrome で 40 チェック / 開発用プロファイルで統合ロード):
    各 type の期限計算、土日祝の forward/backward 調整(例: 金曜 nextDay → 月曜 / 4/25 土曜の
    monthlyDay+backward → 4/24 金曜 / 祝日を挟むケース)、monthlyDay の月末丸め、
    フォームの出し分けと既定調整方向、保存・再オープンの往復、
    一括移動(未設定タスクの警告 → 続行でルール済みのみ移動、完了/進行中/今日以外は不変、
    全件ルールありなら直接実行、今日タスク 0 件のメッセージ、スマホでは無効)。
- **フェーズ3f・追記(実装済み・2026-09-11): 進行中解除時に期限を当日へ更新**
  - タスクの `inProgress` が `true → false` に変わる保存操作で、かつ**同時に完了になるのではない**場合、
    `due` を当日の日付へ更新する(以前の `due` が過去でも未来でも上書き)。「今日」区分に戻り、
    `moveRule` のサイクルを再開できるようにするための挙動。
  - 実装は `onSubmitTask()`(`tasks.js`)のみ。保存直前に `existing.inProgress`(変更前)と
    フォームのチェック状態(変更後)を比較し、`true→false` かつ「完了へ同時遷移」でなければ
    `due = toYmd(new Date())` を使う。完了状態は本フォームでは変更されないため、通常は
    「完了への同時遷移」は起こらない(将来 completed をこのフォームで扱うようになった場合に
    備えたガード)。
  - 一覧の完了チェックボックス(`buildTaskRow`)は `completed` だけを操作し `inProgress` には
    触れないため、現状 `inProgress` を変更できる経路は編集フォームの保存のみ。
  - `moveRule` / `sortTasks()` / `bucketOf()` は変更なし。
  - 変更ファイル: `tasks.js` / `sw.js`(v16)。
  - 稼働確認済み(2026-09-11、ヘッドレス Chrome・開発用ダミーデータ): 期限切れ/未来期限どちらの
    進行中タスクも解除で当日に更新、進行中のまま保存では期限不変、完了チェック(一覧)は
    `inProgress` に影響しないこと、当日へ戻した `moveRule` 付きタスクが「今日のタスクを移動」で
    正しく次回日へ進む(金曜 nextDay → 月曜)ことを確認。
- **フェーズ3・残り(未実装)**
  - 3g: カレンダー連携表示(重要タスクとカレンダーの連動。イベントの `linkedTaskId` を使う)
- **将来フェーズ(構想・未着手)**
  - 通知

## ファイル構成

```
OneBoard-app-dev/
├── CLAUDE.md          # このファイル
├── index.html          # 画面(カレンダー本体 + 各モーダル)
├── style.css            # スタイル
├── events.js            # データ層: 祝日ローダー / 予定ストア(localStorage) / 繰り返し展開
├── app.js               # 画面: 月グリッド描画・ナビゲーション・予定フォーム・モーダル制御
│                         #   + 配信(SyncPrefs / 自動反映)・捕捉インボックス(InboxStore / InboxAck)
├── tasks.js             # タスク管理(3a: CRUD、3b: 区分、3c: 完了+同期、3d: 記載パターン、3f: 移動ルール)。app.js の後
├── holidays.json        # 祝日データ(内閣府公開データを JSON 化して同梱)
├── crypto.js            # 暗号化ユーティリティ(Web Crypto。書き出し/取り込み用)
├── data/oneboard.enc.json # 配信データ(暗号文)。PC が書き出し → push、スマホが取得(gitで管理)
├── server.py            # ローカルサーバー(/__bye /__ping で自動終了 + /__publish で配信データを git push)
├── OneBoard起動.bat    # 【本番用】server.py 起動 + Chrome を新規ウィンドウで開く(既定プロファイル = 本番データ。CRLF 改行必須・変更しない)
├── OneBoard開発用起動.bat # 【開発用】同上だが Chrome を .dev-profile プロファイルで開く(本番 localStorage と分離)
├── dev-seed.js          # 開発用プロファイルにダミーの予定・タスク・設定を投入するコンソールスクリプト
├── .dev-profile/        # 開発用 Chrome プロファイル(.gitignore 済み。初回は空)
├── manifest.webmanifest # PWA マニフェスト(相対URL。start_url/scope とも "./")
├── sw.js                # Service Worker(https のみ。アプリシェル + crypto/tasks.js + holidays.json。配信データは network-first)
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

// タスク: localStorage キー "oneboard.tasks.v1" … Task[](tasks.js の TaskStore)
// Task: {
//   id,                       // UUID
//   title,                    // 件名(自由記述)
//   due,                      // "YYYY-MM-DD" | null(期限日)
//   inProgress,               // true/false。true なら一覧で件名・メタを赤字表示
//   completed,                // true/false(既定 false)。true は区分判定の対象外 →「完了済み」へ
//   completedAt,              // 完了日時(ISO)| null
//   moveRule,                 // 3f: 一括移動ルール。null または:
//                             //  { type:'nextDay'|'weekly'|'monthlyDay'|'interval',
//                             //    weekday?:0-6, day?:1-31, days?:1-365,
//                             //    holidayAdjust:'forward'|'backward' }
//   templateName,             // 3d: タスク作成時に選んだ記載パターン名(自由記載なら null)
//   body,                     // 本文(自由記述)
//   createdAt, updatedAt
// }
//   ※ 3c: 携帯同期の対象(配信ペイロードの tasks[])。taskTemplates は同期しない方針。

// 記載パターン: localStorage キー "oneboard.taskTemplates.v1" … Template[](tasks.js の TaskTemplateStore)
// Template: {
//   id,                       // "tpl-<UUID>"
//   name,                     // パターン名(例 "入社A" / "退社A" / "36協定A")。必須
//   body,                     // 本文の雛形(複数行・自由記述)
//   createdAt, updatedAt
// }
//   ※ 3d: タスク作成時に本文欄へコピーするための雛形。**携帯同期の対象外**(配信ペイロードに載せない)。
//   ※ 並び順は tasks.js の sortTasks(): 進行中 → 期限日(null 末尾)→ 作成順。
//         完了済みは sortCompleted(): 完了日時の新しい順。
//   ※ 3b: 表示は due から都度計算した区分セクションに分ける(bucketOf。区分はタスクに保存しない。
//         週の始まりは月曜。0 件のセクションは非表示。completed は最下部「完了済み」へ)。

// 同期設定: localStorage キー "oneboard.sync.v1" … app.js の SyncPrefs
//   { passphrase,               // 暗号化パスフレーズ(この端末にだけ保存。外部送信なし)
//     lastPulledAt,             // スマホが最後に取り込んだ時刻(ISO)
//     lastPublishedAt,          // 取り込んだデータの publishedAt(= PC が書き出した時刻)
//     autoPublish }             // PC: 保存のたびの自動反映。既定 true。データ画面で切替

// 捕捉インボックス: localStorage キー "oneboard.inbox.v1" … app.js の InboxStore
//   [ { id, text, createdAt, receivedAt? } ]   // receivedAt は PC が取り込んだ分だけ付く
//   スマホ = 「あとで入力」メモ / PC = スマホから取り込んだ未処理メモ。カレンダーとは無関係。

// インボックス受領記録(PC のみ): localStorage キー "oneboard.inboxack.v1" … string[](id、直近 200)
//   PC が取り込んだメモの id。配信データの inboxAck に載せ、スマホが自動で消すのに使う。

// 書き出しファイル data/oneboard.enc.json … crypto.js のエンベロープ(暗号文)
//   { f:"oneboard-enc", v:1,
//     kdf:{name:"PBKDF2",hash:"SHA-256",iter,salt(b64)}, cipher:"AES-GCM", iv(b64), ct(b64) }
//   復号後のペイロード(配信データ):
//   { kind:"oneboard-export", version:1, publishedAt(ISO), events:Event[],
//     settings:{homeStation}, tasks:Task[], inboxAck:string[] }
//     ※ tasks / inboxAck は後方互換の追加(無くても動く。tasks が配列のときだけ全置換)

// 捕捉インボックスの受け渡しファイル oneboard-inbox.enc.json … 同じエンベロープ形式
//   復号後: { kind:"oneboard-inbox", version:1, exportedAt(ISO), items:[{id,text,createdAt}] }
```

- 古い形式のデータは `EventStore.normalize()` が後方互換で補完する(実データを壊さない)。
- 取り込み時は `EventStore.replaceAll()` / `Settings.replaceAll()` /(payload に tasks があれば)
  `TaskStore.replaceAll()` が全置換する(方式Aは一方向のため)。
  捕捉インボックス(`oneboard-inbox`)だけは全置換ではなく `InboxStore.mergeIncoming()` で追記。
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

## PC 復元手順(買い替え・故障時)

手元にバックアップファイル(`oneboard.enc.json`)が無くても、GitHub 上の配信データから戻せる。

1. 新しい PC にリポジトリ一式を配置(`git clone` かフォルダごとコピー)→ `OneBoard起動.bat` で起動。
2. ⚙(データ)→ **パスフレーズを入力**(旧 PC・スマホと同じもの)。
3. 取り込み欄の **「GitHub から復元」** を押す → 確認ダイアログで OK。
   - 内部的には `https://kaihatupp.github.io/OneBoard/data/oneboard.enc.json` を取得し、
     `importEnvelopeText()`(復号 → 全置換)に渡すだけ。
4. 「取り込みました(予定 N 件)」で完了。以降は自動反映が通常どおり動く。

- **パスフレーズだけは GitHub 上にも無い**。これが無いと復元できないので、マサさんが別途控えを保持すること
  (Chrome のパスワード保存ではなく、手元のメモ / パスワード管理アプリ推奨)。
- ローカルにバックアップがある場合は「ファイルから取り込み」でも同じ(全置換 + confirm)。
- スマホしか無い状況では復元不可(スマホは閲覧専用で書き戻し機能なし)。PC が正本。

## SW キャッシュ更新手順

`index.html` / `style.css` / `crypto.js` / `events.js` / `app.js` / `tasks.js` / アイコン / `holidays.json`
を変更したら:

1. `sw.js` の `const CACHE = 'oneboard-vN'` の番号を +1 する(現在 `oneboard-v16`)
   ※ `data/oneboard.enc.json` は precache せず network-first。データ更新でバージョンを上げる必要はない
   ※ `ASSETS` に precache するファイルを増やしたら忘れずに追記(現在 shell 一式 + `crypto.js` + `tasks.js` + `holidays.json`)
2. コミット・push(GitHub Pages に反映)
3. スマホ側は、次回オンラインで開いたときに新 SW が入り、その次の起動から新版になる
   (`skipWaiting` + `clients.claim` 済みだが、確実には一度アプリを閉じて開き直す)

- PC版(localhost)は SW を使わないので、この手順は不要(`server.py` が `no-store` 配信)。

## 個人情報保護の運用ルール

齋藤オフィスの他アプリと同様、開発相談時に実在の個人データをそのまま貼り付けない。
本アプリのデータは常にブラウザ内に留まり、サーバーへは一切送信されない。

- **予定 (`oneboard.events.v1`) / タスク (`oneboard.tasks.v1`) の外部送信は「配信データ」経路のみ**。
  中身は AES-GCM 暗号文(→ 設計制約の例外1・3)。平文が git / GitHub に載ることはない
  (2026-09-09 に git 全履歴・配信ファイルを確認済み。フェーズ3c でタスクも同経路に追加。
  `taskTemplates` は同期対象にしない)。
- **9/7 のデータ復旧作業ファイル**(Chrome LevelDB ダンプ・復旧済み予定の平文 JSON 等)は
  スクラッチパッドから 2026-09-09 に全削除。
- デスクトップに `OneBoard-復旧データ-2026-09-07.json`(復旧済み6件の**平文**バックアップ)が
  残っている。現データは GitHub(暗号化)+ 端末 localStorage にあるので、マサさんが不要と
  判断したら削除してよい。

## 本番データの取り扱い(恒久ルール)

- 開発・動作確認は原則ダミーデータで行う。本番の実タスク・実予定が入った状態での
  機能テストは避け、必要な検証はダミーデータで再現すること。
- やむを得ず本番データに触れる場合(不具合の再現調査など):
  - タスクの title / body、予定の title / note / location、
    パターン(taskTemplates)の name / body など、人が読む自由記述
    フィールドの中身をツール出力・スクリーンショット・会話ログに表示しない。
    件数・型・エラーの有無など、構造的な情報のみを報告する。
  - localStorage の snapshot/restore 等でも同様(2026-09-09 の運用ルールを恒久化。
    この日、タスク一覧の改修テスト中にマサさんの実タスクがツール出力・スクリーンショットに写り、
    セッションログを事後に手作業で伏字化した)。
  - 触れる前に、何を・なぜ確認する必要があるか一言添えてから進める。
- 開発中は下記「開発用プロファイル起動bot」を使い、本番データとは別のブラウザ
  プロファイル(ダミーデータのみ)で動作確認を行うことを基本とする。

### 開発用プロファイル起動bot

- `OneBoard開発用起動.bat` … 本番用 `OneBoard起動.bat` と同じく `server.py` を起動するが、
  Chrome を `--user-data-dir="<このフォルダ>\.dev-profile"` 付きで開く。プロファイルが違えば
  `localhost:8123` の `localStorage` も完全に別物になるので、本番データに一切触れずに検証できる
  (2026-09-10 に実ブラウザで独立を確認)。
- `.dev-profile/` は `.gitignore` 済み(Git 管理外)。初回は空。
- ダミーデータの投入: 開発用プロファイルの DevTools コンソールで
  `fetch('/dev-seed.js').then(r => r.text()).then(eval)` を実行(または `dev-seed.js` の中身を貼り付け)。
  予定・タスク・**記載パターン(taskTemplates)**・設定を「[ダミー]…」で全置換する
  (localhost 以外 / 確認ダイアログでガード)。パターン管理機能も本番プロファイルに触れず確認できる。
- 本番用 `OneBoard起動.bat` は**変更しない**(既定プロファイル = 本番データ)。

## git の著者情報(2026-09-07 に統一済み)

- 全コミットの author / committer を **`kaihatupp <kaihatupp@users.noreply.github.com>`** に統一。
  以前は実名 `齋藤正憲 <office@sr-masa.com>` だったものを `git filter-branch` で全17コミット書き換え、
  `push --force-with-lease` で GitHub にも反映済み。
- リポジトリのローカル設定(`user.name` / `user.email`)も上記に変更済み。**今後もこの名義でコミットする**。
- 姉妹アプリ(gym-training-trend / health-tracker)は ID 付き形式
  `310461674+kaihatupp@users.noreply.github.com` を使用。OneBoard は ID なし形式だが、
  同一 GitHub アカウントに紐づくため実害なし(統一しないことをマサさんが了承済み)。
- 書き換え前の履歴バックアップ: `デスクトップ/OneBoard-履歴バックアップ-書換前-77af123.bundle`
  (マサさんが確認後に削除可)。
