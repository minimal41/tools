# Sheetbase

Google スプレッドシートをデータベースにするサーバー。Firebase や Supabase のように、ブラウザから読み書き・ログインができる。
サーバーは Google Apps Script で動くので、お金もサーバーの用意もいらない。

| ファイル | 中身 |
| --- | --- |
| `Code.gs` | サーバー。スプレッドシートの Apps Script に貼り付ける |
| `sheetbase.js` | クライアント。ブラウザでも Node でも使える |
| `index.html` | 説明と、ブラウザから試せるページ |
| `test/` | Apps Script のまねをして手元で動かすテスト |

## はじめかた

1. 新しい Google スプレッドシートを作り、**拡張機能 → Apps Script** を開く。
2. はじめから入っているコードを消して、`Code.gs` の中身を貼り付ける。
3. 関数 `setup` を選んで **実行**（はじめの 1 回は Google の許可画面が出る）。ログに管理キーが出る。
4. **デプロイ → 新しいデプロイ → ウェブアプリ**。「実行するユーザー：自分」「アクセスできるユーザー：全員」にする。
5. 出てきた URL（`https://script.google.com/macros/s/…/exec`）をクライアントに渡す。

コードやルールを変えたら、**デプロイを管理 → 編集 → 新バージョン** でデプロイし直す（URL は変わらない）。

## つかいかた

```html
<script src="sheetbase.js"></script>
<script>
  const sb = Sheetbase.createClient('https://script.google.com/macros/s/XXXX/exec');
</script>
```

どの呼び出しも `{ data, error, count }` を返し、例外は投げない。`error` は `{ code, message }`。

### データベース

シート 1 枚がテーブル 1 つ。1 行目が列名、2 行目からがデータ。
無いシート・無い列に書くと自動でできる。`id`・`createdAt`・`updatedAt` は自動で入る。

```js
// 足す（1 行でも配列でも）
await sb.from('todos').insert({ title: '牛乳を買う', done: false });

// 読む
const { data, count } = await sb.from('todos')
  .select('id,title')            // 省くと全部の列
  .eq('done', false)
  .order('createdAt', { ascending: false })
  .limit(10);                    // count は limit の前の件数

// 1 行だけ
const { data: todo } = await sb.from('todos').select().eq('id', id).single();

// 書きかえる・消す（条件が必要）
await sb.from('todos').update({ done: true }).eq('id', id);
await sb.from('todos').delete().eq('id', id);

// あれば書きかえ、なければ足す
await sb.from('settings').upsert({ name: 'theme', value: 'dark' }, { onConflict: 'name' });

// 一定時間ごとに見に行き、変わったら呼ばれる
const stop = sb.from('todos').select().subscribe(({ data }) => render(data), { interval: 5000 });
stop();
```

条件：`eq` `neq` `gt` `gte` `lt` `lte` `like` `ilike`（`%` と `_`）`in` `is` `contains` `match`
そのほか：`order` `limit` `range(from, to)` `single` `maybeSingle`

値は、文字・数・真偽・`null`・配列・オブジェクトがそのまま往復する（配列・オブジェクトはセルに JSON で入る）。
空の文字 `''` は `null` として読まれる。シートに手で入れた日付は ISO 形式の文字で読まれる。

### ログイン

```js
await sb.auth.signUp({ email, password });   // パスワードは 8 文字以上
await sb.auth.signIn({ email, password });
sb.auth.getUser();                           // { id, email } か null
sb.auth.onAuthStateChange((event, session) => {});
await sb.auth.signOut();
```

ログイン情報は `localStorage` に置かれ、30 日つづく。
ユーザーはシート `_users` に入る（パスワードはハッシュにして保存）。`_` で始まるシートは API から見えない。

### ルール

だれが読み書きできるかは `Code.gs` の上のほうの `RULES` で決める。

```js
var RULES = {
  '*':   { read: 'public', write: 'auth'  },  // 書いていないテーブル
  todos: { read: 'owner',  write: 'owner' },  // 自分の行だけ
  posts: { read: 'public', write: 'owner' },  // みんなが読めて、書いた人だけが直せる
  inbox: { read: 'admin',  write: 'public' }  // だれでも送れて、管理者だけが読める
};
```

| ルール | 意味 |
| --- | --- |
| `public` | だれでも |
| `auth` | ログインした人 |
| `owner` | ログインした人が、自分の行だけ。足すときに `userId` が自動で入る |
| `admin` | 管理キーを持つ人だけ |

そのほかの設定：`AUTO_SCHEMA`（シート・列を自動で作るか）、`ALLOW_SIGNUP`（だれでも登録できるか）、`TOKEN_DAYS`。

### キー

**プロジェクトの設定 → スクリプト プロパティ** に置く。

| プロパティ | 役わり |
| --- | --- |
| `ADMIN_KEY` | `setup` が作る。すべてのルールを飛ばせる。**ブラウザに配るコードには書かない**（自分のスクリプトやサーバーだけで使う） |
| `API_KEY` | 好きな文字を入れると、このキーを持たない呼び出しを全部ことわる。ページに書くものなので秘密にはならない |
| `SPREADSHEET_ID` | スプレッドシートに付いていないスクリプトから使うとき |

```js
const admin = Sheetbase.createClient(url, { apiKey: ADMIN_KEY });
await admin.tables();
```

### fetch だけで使う

```bash
curl -L 'https://script.google.com/macros/s/XXXX/exec?table=todos&limit=10&order=createdAt.desc'
```

```bash
curl -L -H 'Content-Type: text/plain' \
  -d '{"action":"insert","table":"todos","rows":{"title":"hi"},"token":"…"}' \
  'https://script.google.com/macros/s/XXXX/exec'
```

## 知っておくこと

- **速さ**：1 回の呼び出しに 1〜2 秒かかる。読むたびにシート全体を読むので、数千行くらいまでの小さなアプリ向け。
- **上限**：Apps Script の 1 日あたりの上限がある（無料アカウントで実行時間が合計 90 分ほど）。
- **リアルタイム**：スプレッドシートは変更を知らせてくれないので、`subscribe` は定期的に見に行く方式。
- **安全**：既定のルールは「読むのはだれでも・書くのはログインした人」で、登録もだれでもできる。人に見せたくないデータは `owner` か `admin` にする。パスワードのハッシュは Apps Script で動く軽いものなので、ほかのサービスと同じパスワードは使わないよう伝える。メール確認・パスワード再設定は無い。

## テスト

```bash
node --test sheetbase/test/run.js
```

手元で試すにせサーバー（データはメモリの中、止めると消える）：

```bash
node sheetbase/test/dev-server.js
```

`http://localhost:8787/exec` を URL として使える。
