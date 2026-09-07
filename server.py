#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OneBoard 用のローカル静的サーバー。

`py -m http.server` の代わり。基本は同じくカレントフォルダを配信するだけ。加えて:

- タブ/ウィンドウを閉じると、ページ(app.js)が `POST /__bye` を送る
  (`navigator.sendBeacon`)。数秒後に別タブからの生存確認が来なければ終了する。
  バッチ実行なので、終了するとコンソール窓もそのまま閉じる。
- 保険として `GET /__ping` を約60秒ごとに受け取り、5分途切れたら終了
  (ブラウザのクラッシュ等で `/__bye` が飛ばなかった場合の後始末)。
- `POST /__publish`(方式B): PC アプリの「スマホに反映」ボタンから、暗号化済みの
  配信データを受け取り `data/oneboard.enc.json` に書き、`git add/commit/push` する。
  ボタンを押したときだけ動く。受け取るのは暗号文のみ(パスフレーズは受け取らない)。
  push 先はこのリポジトリの `origin`(マサさん自身の GitHub)。
- 待ち受けは 127.0.0.1 のみ(同一 PC からのみアクセス可)。
- /__ping /__bye は死活監視だけ。ユーザーデータは一切受け取らない・送らない。
"""

import http.server
import json
import os
import subprocess
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
IDLE_TIMEOUT = 300    # 秒: ping がこの時間途切れたら終了(クラッシュ時などの保険)
STARTUP_GRACE = 60    # 秒: 起動直後、ブラウザが開くまでの猶予
BYE_GRACE = 8         # 秒: 「タブを閉じた」通知を受けてからの猶予(別タブがあれば延命)

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_REL = 'data/oneboard.enc.json'
MAX_PUBLISH_BYTES = 5 * 1024 * 1024

_lock = threading.Lock()
_deadline = time.monotonic() + STARTUP_GRACE
_git_lock = threading.Lock()  # /__publish の git 操作を直列化


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

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        if self.path.startswith('/__publish'):
            self._bump(IDLE_TIMEOUT)
            self._handle_publish()
            return
        self.send_error(501, 'Unsupported method (POST)')

    # ---- 方式B: 「スマホに反映」 ----
    def _handle_publish(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_PUBLISH_BYTES:
            self._json({'ok': False, 'stage': 'body', 'message': 'リクエストが不正です'}, 400)
            return
        body = self.rfile.read(length)

        # 受け取ってよいのは OneBoard の暗号化エンベロープだけ(平文は書かせない)
        try:
            env = json.loads(body)
        except json.JSONDecodeError:
            self._json({'ok': False, 'stage': 'body', 'message': 'JSON として読めません'}, 400)
            return
        if not (isinstance(env, dict) and env.get('f') == 'oneboard-enc'
                and env.get('cipher') == 'AES-GCM'
                and env.get('ct') and env.get('iv') and env.get('kdf')):
            self._json({'ok': False, 'stage': 'body',
                        'message': 'OneBoard の暗号化データではありません'}, 400)
            return

        with _git_lock:
            result = _publish_to_git(body)
        self._json(result, 200 if result.get('ok') else 200)

    def log_message(self, *args):
        pass  # アクセスログでコンソールを埋めない


def _git(*args, timeout=20):
    return subprocess.run(
        ['git', *args], cwd=REPO_DIR,
        capture_output=True, text=True, timeout=timeout,
    )


def _publish_to_git(body_bytes):
    """暗号化データを data/oneboard.enc.json に書いて add/commit/push する。"""
    path = os.path.join(REPO_DIR, *DATA_REL.split('/'))
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(body_bytes)
    except OSError as e:
        return {'ok': False, 'stage': 'write', 'message': f'ファイル書き込みに失敗: {e}'}

    try:
        add = _git('add', '--', DATA_REL)
        if add.returncode != 0:
            return {'ok': False, 'stage': 'add', 'message': (add.stderr or add.stdout).strip()}

        commit = _git('commit', '-m', 'OneBoard 配信データ更新', '--', DATA_REL)
        if commit.returncode != 0:
            blob = (commit.stdout + commit.stderr).lower()
            if 'nothing to commit' in blob or 'no changes added' in blob:
                return {'ok': True, 'pushed': False, 'note': '変更なし(すでに最新)',
                        'at': _now_iso()}
            return {'ok': False, 'stage': 'commit',
                    'message': (commit.stderr or commit.stdout).strip()}

        push = _git('push', 'origin', 'HEAD', timeout=60)
        if push.returncode != 0:
            # リモートが進んでいる場合は rebase して 1 回だけ再試行
            branch = _git('rev-parse', '--abbrev-ref', 'HEAD').stdout.strip() or 'HEAD'
            pull = _git('pull', '--rebase', 'origin', branch, timeout=60)
            if pull.returncode == 0:
                push = _git('push', 'origin', 'HEAD', timeout=60)
        if push.returncode != 0:
            return {'ok': False, 'stage': 'push',
                    'message': (push.stderr or push.stdout).strip()
                               or 'git push に失敗しました'}

        sha = _git('rev-parse', '--short', 'HEAD').stdout.strip()
        return {'ok': True, 'pushed': True, 'commit': sha, 'at': _now_iso()}
    except FileNotFoundError:
        return {'ok': False, 'stage': 'git', 'message': 'git が見つかりません'}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'stage': 'git',
                'message': 'git の応答がありません(ネットワーク / 認証を確認してください)'}


def _now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime())


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
    print('  "Publish to phone" commits data/oneboard.enc.json and runs git push.')
    print('  Closing the browser tab stops this server automatically.')
    print('  To stop it now, close this window or press Ctrl+C.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()


if __name__ == '__main__':
    main()
