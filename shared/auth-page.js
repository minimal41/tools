/*
 * ログイン（login.html）・新規登録（signup.html）のページの動き。
 * <body data-mode="login"> か "signup" で、どちらのページかを決める。
 * login.html は「パスワードの再設定」にも切り替えられる。
 *
 * ?next=… が付いていれば、ログイン・登録のあとそのページへもどる（同じサイト内の URL だけ）。
 */
import * as account from './account.js';

window.__toolsAccountLoaded = true;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const form = $('authForm');
const submit = $('authSubmit');
const msg = $('authMsg');
let mode = document.body.dataset.mode; // login / signup / forgot

function nextUrl() {
  const next = params.get('next');
  if (!next) return null;
  try {
    const u = new URL(next, location.href);
    return u.origin === location.origin ? u.href : null;
  } catch { return null; }
}

function showMsg(text, type = 'error') {
  msg.textContent = text;
  msg.className = 'msg ' + type;
  msg.hidden = !text;
}

/* もう一方のページへのリンクにも、もどり先を引き継ぐ */
document.querySelectorAll('a[data-keep-next]').forEach((a) => {
  if (params.get('next')) a.href += '?next=' + encodeURIComponent(params.get('next'));
});

const TEXT = {
  login: { title: 'ログイン', lead: 'Tools のアカウントでログインします。', submit: 'ログイン' },
  forgot: { title: 'パスワードの再設定', lead: '登録したメールアドレスに、再設定用のリンクを送ります。', submit: '再設定メールを送る' },
};

/* login.html の中で「ログイン」と「パスワードの再設定」を切り替える */
function setMode(m) {
  mode = m;
  $('pageTitle').textContent = TEXT[m].title;
  $('pageLead').textContent = TEXT[m].lead;
  submit.textContent = TEXT[m].submit;
  $('passwordField').hidden = m === 'forgot';
  document.querySelectorAll('[data-show]').forEach((el) => { el.hidden = el.dataset.show !== m; });
  document.title = TEXT[m].title + ' - Tools';
  showMsg('');
}
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.goto)));

if (!account.isConfigured) {
  showMsg('アカウント機能を使うには、管理者が shared/config.js に Firebase の設定を書き込む必要があります。', 'info');
  submit.disabled = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email) return showMsg('メールアドレスを入力してください。');
  if (mode !== 'forgot' && !password) return showMsg('パスワードを入力してください。');
  if (mode === 'signup' && password !== $('authPassword2').value) return showMsg('確認用のパスワードが一致しません。');

  submit.disabled = true;
  showMsg('');
  try {
    if (mode === 'forgot') {
      await account.resetPassword(email);
      showMsg('再設定用のメールを送信しました。メール内のリンクから新しいパスワードを設定してください。', 'success');
      return;
    }
    done = true; // ここから先は、ログインできたらすぐ移動する
    if (mode === 'signup') {
      await account.signUp({ email, password, displayName: $('authName').value.trim() });
    } else {
      await account.signIn({ email, password });
    }
    location.href = nextUrl() || 'index.html';
  } catch (err) {
    done = false;
    showMsg(account.errorMessage(err));
  } finally {
    submit.disabled = false;
  }
});

/* すでにログインしているときは、もどり先があればそこへ。無ければその旨を表示する */
let done = false;
account.onUserChanged((user) => {
  if (done) return;
  if (user && nextUrl()) { location.replace(nextUrl()); return; }
  $('signedIn').hidden = !user;
  $('authArea').hidden = !!user;
  if (user) $('signedWho').textContent = user.displayName || user.email;
});
$('logoutBtn').addEventListener('click', () => account.logOut());
