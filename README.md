# tools

| ツール | 内容 |
| --- | --- |
| [Convrt](convrt/) | 画像・PDF・EPUB・音声の変換（直近3回の変換結果をブラウザに保存） |
| [スライド](slides/) | 発表用スライドの作成（ログイン中は Vercel、未ログインはブラウザに保存） |
| [席替え](change-seats/) | 座席表の作成（直近3回の席替えをブラウザに保存） |
| [Making Site](makingsite/) | パーツを組み立ててホームページを作成（[minimal41/makingsite](https://github.com/minimal41/makingsite) から取り込み） |
| [Sheetbase](sheetbase/) | Google スプレッドシートをデータベースにするサーバー |

## アカウントとデータ保存

ログイン・パスワード再設定は **`login.html`**、新規登録は **`signup.html`** で行います（Tools のホームや各ツールからリンクしています）。
`?next=…` を付けて開くと、ログイン・登録のあとそのページへもどります。
各ツールは `shared/account.js` を読み込んでログイン状態を共有します（Making Site 側にはログイン画面はありません）。

| 役割 | 使うもの |
| --- | --- |
| アカウント（メール / パスワード） | Firebase Authentication |
| ユーザー情報（`users/{uid}`: email, displayName, createdAt, lastLoginAt） | Cloud Firestore |
| Making Site のサイト | Vercel（`api/sites.js` → Postgres の `sites` テーブル） |
| スライド | Vercel（`api/decks.js` → Postgres の `decks` テーブル） |
| スライドに追加したフォント | Vercel（`api/fonts.js` → Postgres の `fonts`・`font_chunks` テーブル） |
| ログインの控え | Vercel（`api/session.js` → ブラウザの Cookie。データベースは使わない） |

ブラウザは Firebase の ID トークンを付けて `/api/sites`・`/api/decks`・`/api/fonts` を呼び、サーバー側でトークンを検証して本人のデータだけを返します。

### 1. Firebase の設定

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成し、ウェブアプリを追加する。
2. 表示された `firebaseConfig` の値を `shared/config.js` に貼り付ける。
3. **Authentication** →「Sign-in method」で「メール / パスワード」を有効にする。
   公開するドメイン（例: `tools-xxxx.vercel.app`）を「設定」→「承認済みドメイン」に追加する。
4. **Firestore Database** を作成し、「ルール」に `firestore.rules` の内容を貼り付けて公開する。

### 2. Vercel の設定

1. Vercel で「Add New → Project」からこのリポジトリをインポートする（Framework Preset は「Other」、ビルド設定は不要）。
   ページ（静的ファイル）と `api/` のサーバーレス関数が一緒にデプロイされます。
2. プロジェクトの **Storage** →「Create Database」から **Neon（Postgres）** を作成してプロジェクトに接続する。
   region は **Singapore（`ap-southeast-1`）**。API（`api/`）も `vercel.json` でシンガポール（`sin1`）で動かしているので、
   region を変えるときは `vercel.json` の `regions` も合わせて変える。Auth と Realtime はオフでよい（ログインは Firebase で行う）。
   `DATABASE_URL` が自動で設定されます。テーブル（`sites`・`decks`・`fonts`・`font_chunks`）は最初のアクセス時に自動作成されます。
3. **Settings → Environment Variables** に `FIREBASE_PROJECT_ID`（Firebase のプロジェクト ID）を追加して、再デプロイする。

ページを GitHub Pages など Vercel 以外に置く場合は、`shared/config.js` の `apiBase` に Vercel のアドレスを書きます。

未設定のままでもツール自体は使えます（ログインと保存だけが無効になります）。

> 1回に保存できるサイト・スライドのデータは約 4MB までです（Vercel の制限）。大きな画像を多数埋め込んだサイトは保存できないことがあります。
> 以前の Supabase に保存していたサイトは自動では移行されません。

### スライドの保存先

- Tools のアカウントでログインしていると、スライドはアカウント（Vercel）に保存され、どの端末からでも開けます。
- ログインしていないときは、これまでどおりこのブラウザ（IndexedDB）に保存されます。
- ログイン後、このブラウザだけに保存されたスライドがあれば、スライドの一覧に「アカウントに移す」ボタンが出ます。

### ログイン状態を保つしくみ

- Firebase はログイン状態をブラウザの保存領域（IndexedDB）に覚えているので、ページを移ってもブラウザを閉じても続きます。
- ただしブラウザによっては、しばらく使わないと保存領域を消したり（Safari は約7日）、起動時の確認に失敗してログイン状態を捨てたりします。
  そこで、ログインを続けるための鍵を **JavaScript から読めない Cookie**（`/api/session`、HttpOnly・約400日・使うたびに延長）にも控えておき、
  ログイン状態が消えていたらそこから自動で戻します（`shared/account.js` の `restoreSession`）。
- ログアウトすると控えも消えます。控えは、ページと API を同じ場所（Vercel）に置いているときだけ働きます。
- ブラウザや端末が「終了時に Cookie とサイトデータをすべて消す」設定（シークレットウィンドウ、学校・会社の管理端末、再起動で元に戻る PC など）の場合は、控えも一緒に消えるので、ログインし直す必要があります。
- Convrt・席替え・Sheetbase・スライドの各ページは `shared/account-badge.js` を読み込み、右上に「○○ でログイン中 / ログアウト」（未ログインなら「ログイン」）を表示します。

### スライドのフォント

- フォントの一覧には、ふだんは日本語フォント（Google フォントの日本語対応 66 書体）だけが並びます。
  それ以外は検索欄から Google フォント全書体（`slides/gfonts.js`、1,908 書体・2026年1月時点）を探せて、一度選んだものは次から一覧に並びます。
- Google フォントは、使われたときに初めて読み込みます。
- 「フォントを追加」から、フォントファイル（.ttf / .otf / .woff / .woff2）や、端末に入っているフォントの名前を追加できます。
- 追加したフォント（ファイル・名前・検索して選んだもの）は、ログインしていればアカウントに保存され、同じアカウントならどの端末でも使えます。
  ログインしていないときはそのブラウザの中にだけ保存され、あとでログインすると自動でアカウントに移ります。
- フォントファイルは 1 つ 40MB まで、1 アカウントの合計 150MB までです（Neon の無料枠は全体で 0.5GB なので、大きなフォントを多数入れると圧迫します）。

### 履歴（Convrt・席替え）

どちらも直近3回分を、そのブラウザの中にだけ保存します（外部には送信しません）。

- Convrt：変換したファイルそのもの（IndexedDB）。一覧から再保存・削除できます。
- 席替え：座席表と入力内容（localStorage）。「表示」でその時の座席表と入力に戻り、PDF・Excel 保存もできます。
