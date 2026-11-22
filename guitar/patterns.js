/*
 * リズムの型
 *
 * tokens を res（16分音符いくつ分か）おきに置き、足りなければくり返す。
 *
 * ストローク：'D' ダウン / 'U' アップ / 'Dx' 'Ux' ブラッシング（弦をミュートして弾く）/ 'B' ベース音だけ / '' 休み
 * アルペジオ：各ステップで弾く弦の配列。
 *   'B' = コードのいちばん低い音（ベース）、'N' = ベースのすぐ上の弦、'1'〜'6' = 弦の番号
 *   （押さえ方で弾かない弦や、ベースより低い弦は飛ばす）
 */

export const STROKES = [
  { id: 's-whole', name: '全音符', hint: 'ジャーン', res: 16, tokens: ['D'] },
  { id: 's-4', name: '4分ダウン', hint: 'ジャン・ジャン・ジャン・ジャン', res: 4, tokens: ['D'] },
  { id: 's-8d', name: '8分ダウン', hint: '8分で全部ダウン', res: 2, tokens: ['D'] },
  { id: 's-8du', name: '8分ダウンアップ', hint: 'ジャカジャカ', res: 2, tokens: ['D', 'U'] },
  { id: 's-8beat', name: '8ビート', hint: 'ジャン・ジャカ・ジャカジャカ', res: 2, tokens: ['D', '', 'D', 'U', '', 'U', 'D', 'U'] },
  { id: 's-16beat', name: '16ビート', hint: '16分で ジャン・ジャカ・ジャカジャカ', res: 1, tokens: ['D', '', 'D', 'U', '', 'U', 'D', 'U'] },
  { id: 's-16', name: '16分ダウンアップ', hint: '16分で全部', res: 1, tokens: ['D', 'U'] },
  { id: 's-cut', name: 'カッティング', hint: 'ジャカ・チャカ（ブラッシング入り）', res: 1, tokens: ['D', 'U', 'Dx', 'U'] },
  { id: 's-bass', name: 'ベース＋ストローク', hint: 'ボン・ジャカ', res: 2, tokens: ['B', '', 'D', 'U'] },
  { id: 's-waltz', name: 'ワルツ', hint: '3拍子：ボン・チャッ・チャッ', res: 4, tokens: ['B', 'D', 'D'] },
  { id: 's-68', name: '6/8', hint: 'ジャン・ジャン・ジャカ を2回', res: 2, tokens: ['D', 'D', 'U', 'D', 'D', 'U'] },
];

export const ARPEGGIOS = [
  { id: 'a-basic', name: '基本', hint: 'B・3・2・3・1・3・2・3（8分）', res: 2, tokens: [['B'], ['3'], ['2'], ['3'], ['1'], ['3'], ['2'], ['3']] },
  { id: 'a-updown', name: '上がって下がる', hint: 'B・N・3・2・1・2・3・N（8分）', res: 2, tokens: [['B'], ['N'], ['3'], ['2'], ['1'], ['2'], ['3'], ['N']] },
  { id: 'a-short', name: '2拍ずつ', hint: 'B・3・2・3（8分）', res: 2, tokens: [['B'], ['3'], ['2'], ['3']] },
  { id: 'a-16', name: '16分', hint: 'B・3・2・3 を1拍で', res: 1, tokens: [['B'], ['3'], ['2'], ['3']] },
  { id: 'a-travis', name: 'スリーフィンガー', hint: 'B+1・2・N・1・B・2・N・1（8分）', res: 2, tokens: [['B', '1'], ['2'], ['N'], ['1'], ['B'], ['2'], ['N'], ['1']] },
  { id: 'a-chord', name: 'ボン・チャン', hint: 'B・321・N・321（4分）', res: 4, tokens: [['B'], ['3', '2', '1'], ['N'], ['3', '2', '1']] },
  { id: 'a-waltz', name: '3拍子', hint: 'B・3・2・1・2・3（8分）', res: 2, tokens: [['B'], ['3'], ['2'], ['1'], ['2'], ['3']] },
];

/** アルペジオの記号を、押さえ方（6本分のフレット）で実際に弾く弦（0=6弦…5=1弦）にする */
export function resolveArp(roles, frets) {
  const played = [];
  frets.forEach((f, s) => { if (f !== 'x') played.push(s); });
  if (!played.length) return [];
  const bass = played[0];
  const out = new Set();
  for (const r of roles) {
    if (r === 'B') out.add(bass);
    else if (r === 'N') { if (played[1] != null) out.add(played[1]); }
    else {
      const s = 6 - Number(r);
      if (s > bass && frets[s] !== 'x') out.add(s);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** パターンを短い文字で（一覧の見本用） */
export function strokeGlyph(t) {
  return { D: '↓', U: '↑', Dx: '↓×', Ux: '↑×', B: 'B', '': '・' }[t] ?? '・';
}
