/*
 * Tools のページ（リポジトリ直下の静的ファイル）を app/www にコピーする。
 * Android アプリはこの www をそのまま中に入れるので、通信がなくてもページが開ける。
 */
import { cpSync, rmSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');           // リポジトリ直下
const out = join(here, '..', 'www');

// アプリに入れないもの（サーバー側・開発用）
const skip = new Set([
  '.git', '.github', '.vercel', 'app', 'api', 'node_modules',
  'package.json', 'package-lock.json', 'vercel.json', 'firestore.rules', '.gitignore',
]);
const skipPath = (p) => /(^|\/)test(\/|$)/.test(p) || p.endsWith('.md') || p.endsWith('.gs');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of readdirSync(root)) {
  if (skip.has(name)) continue;
  cpSync(join(root, name), join(out, name), {
    recursive: true,
    filter: (src) => !skipPath(relative(root, src)),
  });
}

// ページから window.Capacitor.registerPlugin などを使えるようにする
copyFileSync(join(here, '..', 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), join(out, 'capacitor.js'));

console.log('www を作成しました:', out);
