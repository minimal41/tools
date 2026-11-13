/*
 * Tools の設定
 *
 * ■ Firebase（アカウントとユーザー情報）
 *
 * Firebase コンソール →「プロジェクトの設定」→「マイアプリ」→ ウェブアプリの
 * firebaseConfig の値をそのまま貼り付けてください。
 * 必要な準備は README.md の「アカウント（Firebase）」を参照。
 *
 * ※ この値は公開しても問題ない識別子です（データは firestore.rules で保護します）。
 */
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

/*
 * ■ Vercel（サイトなどのデータ保存 API）
 *
 * このリポジトリを Vercel にデプロイしている場合は '' のまま（同じ場所の /api を使う）。
 * ページを GitHub Pages など別の場所に置く場合は、Vercel のアドレスを書く。
 *   例: 'https://tools-xxxx.vercel.app'
 */
export const apiBase = '';
