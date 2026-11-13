# tools

| ツール | 内容 |
| --- | --- |
| [Convrt](convrt/) | 画像・PDF・EPUB・音声の変換 |
| [スライド](slides/) | 発表用スライドの作成 |
| [席替え](change-seats/) | 座席表の作成 |
| [Making Site](makingsite/) | パーツを組み立ててホームページを作成（[minimal41/makingsite](https://github.com/minimal41/makingsite) から取り込み） |
| [Sheetbase](sheetbase/) | Google スプレッドシートをデータベースにするサーバー |

## アカウント（Firebase）

アカウントの作成・ログイン・パスワード再設定は **Tools のホーム（`index.html`）** で行います。
各ツールは `shared/account.js` を読み込んでログイン状態を共有します（Making Site 側にはログイン画面はありません）。

- 認証: Firebase Authentication（メール / パスワード）
- ユーザー情報の保存: Cloud Firestore

```
users/{uid}                  email, displayName, createdAt, lastLoginAt
users/{uid}/sites/{siteId}   Making Site のサイト（title, html, state, createdAt, updatedAt）
```

### 設定手順

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成し、ウェブアプリを追加する。
2. 表示された `firebaseConfig` の値を `shared/firebase-config.js` に貼り付ける。
3. **Authentication** →「Sign-in method」で「メール / パスワード」を有効にする。
   公開するドメイン（例: `minimal41.github.io`）を「設定」→「承認済みドメイン」に追加する。
4. **Firestore Database** を作成し、「ルール」に `firestore.rules` の内容を貼り付けて公開する
   （本人のデータだけを読み書きできるルールです）。

未設定のままでもツール自体は使えます（ログインと保存だけが無効になります）。

> Firestore の 1 ドキュメントは最大 1MB です。Making Site で大きな画像を多数埋め込んだサイトは保存できないことがあります。
> 以前の Supabase に保存していたサイトは自動では移行されません。
