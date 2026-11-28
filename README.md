# tools

| ツール | 内容 |
| --- | --- |
| [Convrt](convrt/) | 画像・PDF・EPUB・音声の変換（直近3回の変換結果をブラウザに保存） |
| [スライド](slides/) | 発表用スライドの作成（ログイン中は Vercel、未ログインはブラウザに保存） |
| [チェックリスト](checklist/) | チェックリストの作成（ログイン中はアカウント、未ログインはブラウザに保存） |
| [ギター譜](guitar/) | 保存した曲の一覧（`guitar/index.html`）から、曲ごとのページ（`guitar/edit.html?id=…`）を開いて編集。TAB 譜の作成。コード・押さえ方・リズム（ストローク / アルペジオ）を選んで流し込み、カポ・再生・印刷に対応（ログイン中はアカウント、未ログインはブラウザに保存） |
| [Music](music/) | スマホの音楽（MP3 など）をオフラインで再生。曲・アルバム・アーティスト別の一覧、ID3 タグの曲名・アーティスト・アルバム・ジャケット表示、アルバムだけの再生、バックグラウンド再生（Android アプリでは端末の音楽をすべて自動で表示） |
| [席替え](change-seats/) | 座席表の作成（直近3回の席替えをブラウザに保存） |
| [Making Site](makingsite/) | パーツを組み立ててホームページを作成（[minimal41/makingsite](https://github.com/minimal41/makingsite) から取り込み） |
| [Sheetbase](sheetbase/) | Google スプレッドシートをデータベースにするサーバー |

## Android アプリ（APK）

Tools 全体を Android アプリにしたものを `app/` で作ります（[Capacitor](https://capacitorjs.com/)）。
ページはアプリの中に入っているので、通信がなくても開けます（ログインと保存は通信が必要。API は `shared/config.js` の `appApiBase()` のアドレスへ送る）。

### ダウンロード

- `main` に入ると GitHub Actions（`.github/workflows/android.yml`）が APK を作り、リリース **`android-latest`** の `tools.apk` を差し替えます。
  スマホで `https://github.com/minimal41/tools/releases/tag/android-latest` を開いてダウンロードし、インストールしてください
  （初回は「提供元不明のアプリ」のインストールを許可する必要があります）。
- ほかのブランチでは、Actions の実行結果の「tools-apk」から APK を取れます。

### 自動更新（APK を入れ直さなくてよい変更）

- アプリは起動時とアプリに戻ったとき（30 分おき）に、リリース `android-latest` の `web.json` を確かめます。
  ページ（HTML・JS・CSS）が新しくなっていれば `web.zip` をダウンロードしてアプリの中に保存し、**次にアプリを開いたとき**から使います。
  Tools のホームに「新しいバージョンを取り込みました」と出たときは「今すぐ反映」でもすぐ切り替えられます。保存したページは通信がなくても開けます。
- Android 側の仕組み（`app/android/app/src/main/java` の Java、`AndroidManifest.xml`、Gradle、Capacitor）が変わった版は、ページだけ入れ替えると動かないので取り込みません。
  その場合はホームに「アプリ本体の新しいバージョンがあります」と出るので、`tools.apk` を入れ直してください。
  見分けには `app-version.json` の `nativeHash`（`app/scripts/build-www.mjs` が作る）を使います。
- 新しいページで正しく起動できなかったとき（20 秒以内にページから `ready` が届かない）は、自動で前のページに戻し、その版は取り込みません。
- 新しい APK を入れると、アプリに入っているページに戻ってから、また最新を確かめます。
- ホームのいちばん下に、いま使っている版（`アプリ版 xxxxxxx`）と「更新を確認」が出ます。
- しくみ：`app/android/app/src/main/java/com/minimal41/tools/AppUpdatePlugin.java`（アプリ側）、`shared/app-update.js`（ページ側）。

### 署名（上書きインストールのために一度だけ設定）

Secrets が無いと debug 版になり、ビルドのたびに鍵が変わるので、更新するには一度アンインストールが必要です。
同じ鍵で署名し続けるには、手元で鍵を作って GitHub の **Settings → Secrets and variables → Actions** に登録します。

```sh
keytool -genkeypair -keystore tools.keystore -alias tools -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 tools.keystore   # 出てきた文字列を ANDROID_KEYSTORE_BASE64 に
```

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 上の `base64` の結果 |
| `ANDROID_KEYSTORE_PASSWORD` | 鍵ストアのパスワード |
| `ANDROID_KEY_ALIAS` | `tools` |
| `ANDROID_KEY_PASSWORD` | 鍵のパスワード（鍵ストアと同じなら省略可） |

鍵ファイル（`tools.keystore`）はリポジトリに入れず、なくさないよう保管してください（なくすと同じアプリとして更新できなくなります）。

### 手元でビルドする

JDK 21 と Android SDK（`ANDROID_HOME`）が必要です。

```sh
cd app
npm install
npm run apk        # → app/android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run sync` はページ（リポジトリ直下のファイル）を `app/www` にコピーしてアプリに入れます。ページを変えたらビルドし直してください。

### Music（音楽プレーヤー）のしくみ

| | Android アプリ | ブラウザ |
| --- | --- | --- |
| 曲の一覧 | 端末の音楽ファイルをすべて自動で表示（`MusicLibraryPlugin.java`、MediaStore。初回に「音楽とオーディオ」の許可が必要） | 「＋」から選んだファイル・フォルダをブラウザ（IndexedDB）に保存 |
| タグ | Android がファイルの ID3 タグから読んだ曲名・アーティスト・アルバム・トラック番号 | `music/id3.js` で ID3v1 / v2.2〜2.4 を読む（Shift_JIS のタグにも対応） |
| ジャケット | 曲に埋め込まれた画像（APIC）を取り出してアプリのキャッシュに保存 | 同じく APIC をブラウザに保存 |
| 再生 | 再生サービス（`PlaybackService.java`、Media3）。画面を消しても・ほかのアプリを開いても続き、通知・ロック画面・イヤホンのボタンで操作できる | `<audio>` と Media Session |

アルバムを開いて「再生」「シャッフル」を押すと、そのアルバムの曲だけを再生します。アルバムの「並べ替え」で曲の順番を変えられます（端末・ブラウザごとに保存。「元の順に戻す」でトラック番号順に戻る）。

曲の右の「⋮」（スマホは曲の長押し、PC は右クリック・トラックパッドの 2 本指タップでも同じ）から、次に再生・再生キューに追加・アルバム／アーティストを開く・曲の情報を編集・削除ができます。
曲の情報の編集はこの端末・ブラウザの Music での表示だけを変えます（ファイルのタグは書き換えない。「タグの情報に戻す」で元どおり）。
削除は、アプリではスマホから音楽ファイルを消します（Android 11 以降は Android の確認画面が出る）。ブラウザ版はブラウザに保存した曲だけを消します。

再生回数は 1 曲を 30 秒（短い曲は半分）以上聴くと 1 回と数えます。アプリでは再生サービスの中で数えるので、画面を消していても数えられます（`PlayCounter.java`）。曲とアルバムの一覧は「再生回数が多い順」に並べられます。アプリに戻ったときは、新しくダウンロードした曲を自動で読み込み直します（右上の更新ボタンでも読み込めます）。

## アカウントとデータ保存

ログイン・パスワード再設定は **`login.html`**、新規登録は **`signup.html`** で行います（Tools のホームや各ツールからリンクしています）。
`?next=…` を付けて開くと、ログイン・登録のあとそのページへもどります。
各ツールは `shared/account.js` を読み込んでログイン状態を共有します（Making Site 側にはログイン画面はありません）。

| 役割 | 使うもの |
| --- | --- |
| アカウント（メール / パスワード） | Firebase Authentication |
| ユーザー情報（`users/{uid}`: email, displayName, createdAt, lastLoginAt） | Cloud Firestore |
| Making Site のサイト | Vercel（`api/sites.js` → Postgres の `sites` テーブル） |
| チェックリスト | Cloud Firestore（`users/{uid}/checklists/{id}`。`firestore.rules` で本人だけが読み書きできる） |
| ギター譜 | Cloud Firestore（`users/{uid}/guitarTabs/{id}`。曲の中身は `data` に JSON 文字列で保存） |
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
