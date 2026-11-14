/*
 * ログイン状態の表示（Tools の各ページ共通）
 *
 * どのツールを開いていても、いまログインしているかが分かるようにする。
 * ページに [data-tools-account] の要素があればそこへ、無ければ右上に表示する。
 *   data-tools-account="name" … 名前だけ（編集中にログアウトして保存先が変わらないように）
 *
 * ログインそのものは Firebase がブラウザに覚えているので、ページを移っても、
 * ブラウザを閉じても、ログアウトするまで続く。
 */
import * as account from './account.js';

// このファイルから見た Tools のホーム
const home = new URL('../index.html', import.meta.url).href;

let box = document.querySelector('[data-tools-account]');
const nameOnly = box?.dataset.toolsAccount === 'name';
if (!box) {
  box = document.createElement('div');
  box.style.cssText = 'position:absolute;top:10px;right:14px;z-index:5;';
  document.body.append(box);
}
box.style.fontSize = '12px';
box.style.lineHeight = '1.6';
box.style.whiteSpace = 'nowrap';
box.style.maxWidth = '70vw';
box.style.overflow = 'hidden';
box.style.textOverflow = 'ellipsis';

const link = (text, onClick, href) => {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = href || '#';
  a.style.cssText = 'color:inherit;opacity:.75;text-decoration:underline;text-underline-offset:3px;margin-left:10px;';
  if (onClick) a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return a;
};

if (account.isConfigured) {
  account.onUserChanged((user) => {
    if (user) {
      const who = document.createElement('span');
      who.textContent = (user.displayName || user.email) + (nameOnly ? '' : ' でログイン中');
      who.style.opacity = '.75';
      box.replaceChildren(who);
      if (!nameOnly) {
        box.append(link('ログアウト', async () => {
          await account.logOut();
          location.reload();   // 保存先などの表示をログアウト後の状態に合わせる
        }));
      }
    } else {
      box.replaceChildren(link('ログイン', null, account.loginUrl(home, 'login')));
      box.firstChild.style.marginLeft = '0';
    }
  });
}
