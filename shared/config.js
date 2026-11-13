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
const firebaseConfig = {
  apiKey: "AIzaSyD9XlO1cCIZEPldyIRWqsjEe7cP3ToINkM",
  authDomain: "minimal41-tools.firebaseapp.com",
  projectId: "minimal41-tools",
  storageBucket: "minimal41-tools.firebasestorage.app",
  messagingSenderId: "169216843768",
  appId: "1:169216843768:web:c0542f0ec078b44095800d",
  measurementId: "G-14CV51MJN0"
};

/*
 * ■ Vercel（サイトなどのデータ保存 API）
 *
 * このリポジトリを Vercel にデプロイしている場合は '' のまま（同じ場所の /api を使う）。
 * ページを GitHub Pages など別の場所に置く場合は、Vercel のアドレスを書く。
 *   例: 'https://tools-xxxx.vercel.app'
 */
export const apiBase = '';
