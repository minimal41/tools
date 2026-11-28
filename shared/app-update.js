/*
 * Android アプリの自動更新（ページ側）
 *
 * - アプリで開いたときだけ動く（ブラウザでは何もしない）
 * - ページが開けたことをアプリに知らせる（新しい版で正しく起動できたかの確認。届かないと前の版に戻る）
 * - Tools のホームでは、フッターに版と「更新を確認」を出し、
 *   新しいページを取り込んだら「今すぐ反映」、アプリ本体の更新があれば「ダウンロード」を案内する
 *
 * 更新のしくみはアプリ側（app/android/.../AppUpdatePlugin.java）を参照。
 */

const isApp = !!window.androidBridge && location.hostname === 'localhost';

function loadCapacitor() {
  if (window.Capacitor?.registerPlugin) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = new URL('../capacitor.js', import.meta.url).href;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
}

async function start() {
  if (!isApp) return;
  await loadCapacitor();
  const Cap = window.Capacitor;
  if (!Cap?.registerPlugin || !Cap.isPluginAvailable?.('AppUpdate')) return;
  const AppUpdate = Cap.registerPlugin('AppUpdate');
  const info = await AppUpdate.ready().catch(() => null);

  const footer = document.querySelector('.site-footer .footer-inner');
  if (!footer) return; // バナーと版の表示は Tools のホームだけ

  injectStyle();
  const line = document.createElement('div');
  line.className = 'app-version';
  footer.append(line);
  const banner = document.createElement('div');
  banner.className = 'app-update-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  document.body.append(banner);

  let dismissed = '';
  const show = (i) => {
    if (!i) return;
    // フッター：版と「更新を確認」
    line.replaceChildren(
      document.createTextNode('アプリ版 ' + (i.running || '—').slice(0, 7) + ' ・ '),
      link(i.checking ? '確認中…' : '更新を確認', async () => {
        line.querySelector('a').textContent = '確認中…';
        const r = await AppUpdate.checkNow().catch(() => null);
        show(r);
        if (r && !r.readyToApply && !r.nativeUpdate) {
          flash(r.error ? '確認できませんでした（通信を確認してください）' : '最新です');
        }
      }),
    );
    // バナー
    const key = (i.readyToApply ? 'web' : '') + (i.nativeUpdate ? 'native' : '');
    if (!key || key === dismissed) { banner.hidden = true; return; }
    const close = button('あとで', () => { dismissed = key; banner.hidden = true; }, 'ghost');
    if (i.readyToApply) {
      banner.replaceChildren(
        text('Tools の新しいバージョンを取り込みました。次に開いたときに切り替わります。'),
        buttons(close, button('今すぐ反映', () => AppUpdate.apply())),
      );
    } else {
      banner.replaceChildren(
        text('アプリ本体の新しいバージョンがあります。この更新は tools.apk を入れ直すと使えます。'),
        buttons(close, button('ダウンロード', () => AppUpdate.openApkPage())),
      );
    }
    banner.hidden = false;
  };

  show(info || await AppUpdate.getInfo().catch(() => null));
  AppUpdate.addListener('update', show);
}

function text(t) {
  const p = document.createElement('p');
  p.textContent = t;
  return p;
}

function buttons(...els) {
  const d = document.createElement('div');
  d.className = 'btns';
  d.append(...els);
  return d;
}

function button(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function link(label, onClick) {
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = label;
  a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return a;
}

let flashTimer;
function flash(msg) {
  let t = document.querySelector('.app-update-flash');
  if (!t) {
    t = document.createElement('div');
    t.className = 'app-update-flash';
    t.setAttribute('role', 'status');
    document.body.append(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

function injectStyle() {
  const css = `
  .app-version { font-size: 11.5px; color: var(--faint, #9c9a94); }
  .app-version a { color: inherit; text-underline-offset: 3px; }
  .app-update-banner, .app-update-flash {
    position: fixed; left: 16px; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 50;
    max-width: 520px; margin: 0 auto; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18);
    background: var(--ink, #1d1d1b); color: var(--bg, #fff); font-size: 13.5px; line-height: 1.6;
  }
  .app-update-banner { padding: 14px 16px 12px; }
  .app-update-banner p { margin: 0 0 10px; }
  .app-update-banner .btns { display: flex; justify-content: flex-end; gap: 8px; }
  .app-update-banner button {
    font: inherit; font-size: 13px; border-radius: 999px; padding: 6px 16px; cursor: pointer;
    border: 1px solid var(--accent, #c8462c); background: var(--accent, #c8462c); color: #fff;
  }
  .app-update-banner button.ghost { background: transparent; border-color: rgba(255,255,255,.35); color: inherit; }
  .app-update-flash { padding: 10px 16px; text-align: center; pointer-events: none; }
  .app-update-banner[hidden], .app-update-flash[hidden] { display: none; }`;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.append(s);
}

start();
