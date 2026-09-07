#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OneBoard 用のローカル静的サーバー。

`py -m http.server` の代わり。基本は同じくカレントフォルダを配信するだけ。加えて:

- タブ/ウィンドウを閉じると、ページ(app.js)が `POST /__bye` を送る
  (`navigator.sendBeacon`)。数秒後に別タブからの生存確認が来なければ終了する。
  バッチ実行なので、終了するとコンソール窓もそのまま閉じる。
- 保険として `GET /__ping` を約60秒ごとに受け取り、5分途切れたら終了
  (ブラウザのクラッシュ等で `/__bye` が飛ばなかった場合の後始末)。
- 待ち受けは 127.0.0.1 のみ(同一 PC からのみアクセス可)。
- /__ping /__bye は死活監視だけ。ユーザーデータは一切受け取らない・送らない。
"""

import http.server
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
IDLE_TIMEOUT = 300    # 秒: ping がこの時間途切れたら終了(クラッシュ時などの保険)
STARTUP_GRACE = 60    # 秒: 起動直後、ブラウザが開くまでの猶予
BYE_GRACE = 8         # 秒: 「タブを閉じた」通知を受けてからの猶予(別タブがあれば延命)

_lock = threading.Lock()
_deadline = time.monotonic() + STARTUP_GRACE


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 開発中はキャッシュ無効化。CSS/JS を編集したら再読み込みで必ず反映される。
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def _bump(self, seconds):
        global _deadline
        with _lock:
            _deadline = time.monotonic() + seconds

    def _no_content(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):  # noqa: N802 (http.server の命名に合わせる)
        if self.path.startswith('/__ping'):
            self._bump(IDLE_TIMEOUT)
            self._no_content()
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802
        if self.path.startswith('/__bye'):
            # タブ/ウィンドウを閉じた。別タブがまだ開いていれば、この直後に
            # /__ping が来て _deadline が押し戻される(= 延命)。
            self._bump(BYE_GRACE)
            self._no_content()
            return
        self.send_error(501, 'Unsupported method (POST)')

    def log_message(self, *args):
        pass  # アクセスログでコンソールを埋めない


def _watchdog(httpd):
    while True:
        time.sleep(1)
        with _lock:
            expired = time.monotonic() > _deadline
        if expired:
            print('\n  Browser closed - shutting down the OneBoard server.')
            threading.Thread(target=httpd.shutdown, daemon=True).start()
            return


def main():
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=_watchdog, args=(httpd,), daemon=True).start()
    print(f'  OneBoard  -  http://localhost:{PORT}/')
    print('  Closing the browser tab stops this server automatically.')
    print('  To stop it now, close this window or press Ctrl+C.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()


if __name__ == '__main__':
    main()
