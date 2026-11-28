/*
 * Tools のページ（リポジトリ直下の静的ファイル）を app/www にコピーする。
 * Android アプリはこの www をそのまま中に入れるので、通信がなくてもページが開ける。
 */
import { cpSync, rmSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/*
 * 自動更新のための版の情報（app-version.json）
 *   version    … ページの中身から作る番号（中身が同じなら同じ）
 *   nativeHash … Android 側の仕組み（Java・マニフェスト・Gradle・Capacitor）から作る番号。
 *                これが違う版のページは、アプリに取り込まず「アプリの更新があります」と知らせる。
 */
function listFiles(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...listFiles(p, base));
    else files.push(relative(base, p).split('\\').join('/'));
  }
  return files.sort();
}

function hashFiles(base, files) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f + '\0');
    h.update(readFileSync(join(base, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

const version = hashFiles(out, listFiles(out).filter((f) => f !== 'app-version.json'));

const appDir = join(here, '..');
const nativeFiles = [
  ...listFiles(join(appDir, 'android', 'app', 'src', 'main', 'java')).map((f) => 'android/app/src/main/java/' + f),
  'android/app/src/main/AndroidManifest.xml',
  'android/app/build.gradle',
  'android/variables.gradle',
  'package-lock.json',
];
const nativeHash = hashFiles(appDir, nativeFiles);

writeFileSync(join(out, 'app-version.json'), JSON.stringify({ version, nativeHash, builtAt: new Date().toISOString() }) + '\n');

console.log('www を作成しました:', out, '（版', version, '／ Android 側', nativeHash + '）');
