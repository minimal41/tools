/*
 * Firebase プロジェクトの設定
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
