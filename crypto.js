'use strict';

/* =========================================================================
 * OneBoard - 暗号化ユーティリティ(書き出し/取り込み用)
 *
 * ブラウザ標準の Web Crypto(window.crypto.subtle)だけを使う。ライブラリ不使用。
 * secure context(https または localhost)でのみ動作する。
 *
 *   obEncrypt(obj, passphrase)      -> エンベロープ JSON 文字列
 *   obDecrypt(envelopeText, pass)   -> 元のオブジェクト(パスフレーズ違い/改竄で throw)
 *                                      エンベロープに z:'gzip' があれば復号後に展開(新旧どちらも読める)
 *
 * パスフレーズはこのファイルでは保存しない(呼び出し側の責任)。
 * ======================================================================= */

const OB_ENC_FORMAT = 'oneboard-enc';
const OB_KDF_ITER = 210000; // PBKDF2-SHA256(OWASP 目安)。ブラウザで 1 秒未満

/* ---------- base64 <-> ArrayBuffer ---------- */
function obBytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function obB64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------- パスフレーズ -> AES-GCM 鍵 ---------- */
async function obDeriveKey(passphrase, salt, iterations) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* ---------- 暗号化 ---------- */
async function obEncrypt(obj, passphrase) {
  if (!passphrase) throw new Error('パスフレーズが空です');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await obDeriveKey(passphrase, salt, OB_KDF_ITER);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return JSON.stringify({
    f: OB_ENC_FORMAT,
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: OB_KDF_ITER, salt: obBytesToB64(salt) },
    cipher: 'AES-GCM',
    iv: obBytesToB64(iv),
    ct: obBytesToB64(ct),
  }, null, 0);
}

/* ---------- 復号 ---------- */
async function obDecrypt(envelopeText, passphrase) {
  if (!passphrase) throw new Error('パスフレーズが空です');

  let env;
  try {
    env = JSON.parse(envelopeText);
  } catch (e) {
    throw new Error('暗号化ファイルとして読めません');
  }
  if (!env || env.f !== OB_ENC_FORMAT || env.cipher !== 'AES-GCM' || !env.kdf) {
    throw new Error('OneBoard の暗号化ファイルではありません');
  }

  const salt = obB64ToBytes(env.kdf.salt);
  const iv = obB64ToBytes(env.iv);
  const iterations = env.kdf.iter || OB_KDF_ITER;
  const key = await obDeriveKey(passphrase, salt, iterations);

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, obB64ToBytes(env.ct),
    );
  } catch (e) {
    // AES-GCM は認証付き。パスフレーズ違い・改竄はここで例外になる。
    throw new Error('パスフレーズが違うか、ファイルが壊れています');
  }
  // 圧縮の印(env.z === 'gzip')があれば、復号後に展開してから読む。印が無ければ従来どおり。
  // (段階1: 読み取り側のみ対応。書き出し側の圧縮は段階2で有効化する)
  if (env.z !== undefined) {
    if (env.z !== 'gzip') {
      throw new Error('このファイルは新しい形式です。アプリを最新版に更新してから、もう一度お試しください');
    }
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('このブラウザは圧縮データの展開に対応していません。Chrome など新しいブラウザでお試しください');
    }
    let inflated;
    try {
      const stream = new Blob([plaintext]).stream().pipeThrough(new DecompressionStream('gzip'));
      inflated = await new Response(stream).arrayBuffer();
    } catch (e) {
      throw new Error('圧縮データの展開に失敗しました。ファイルが壊れている可能性があります');
    }
    return JSON.parse(new TextDecoder().decode(inflated));
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
}
