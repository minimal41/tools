/* スライド：ホーム（一覧とテンプレート） */
'use strict';

const $ = s => document.querySelector(s);

const open = id => { location.href = 'editor.html?id=' + encodeURIComponent(id); };

function fmtDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function button(label, fn, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', fn);
  return b;
}

function renderTemplates() {
  $('#templates').replaceChildren(...THEMES.map(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'card';
    const name = document.createElement('div');
    name.className = 'card-title';
    name.textContent = t.name;
    const note = document.createElement('div');
    note.className = 'card-meta';
    note.textContent = t.note;
    b.append(makeThumb(buildSlide(t, 'title', { a: t.name, b: t.note })), name, note);
    b.addEventListener('click', async () => {
      const d = newDeck(t.id);
      await DB.put(d);
      open(d.id);
    });
    return b;
  }));
}

async function renderDecks() {
  const decks = (await DB.all()).sort((a, b) => b.updated - a.updated);
  $('#empty').hidden = decks.length > 0;
  $('#decks').replaceChildren(...decks.map(d => {
    const art = document.createElement('article');
    art.className = 'card deck';

    const a = document.createElement('a');
    a.href = 'editor.html?id=' + encodeURIComponent(d.id);
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = d.title;
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = `${d.slides.length}枚 ・ ${fmtDate(d.updated)}`;
    a.append(makeThumb(d.slides[0]), title, meta);

    const acts = document.createElement('div');
    acts.className = 'deck-actions';
    acts.append(
      button('名前変更', async () => {
        const v = prompt('スライドの名前', d.title);
        if (v == null || !v.trim()) return;
        d.title = v.trim().slice(0, 100);
        await DB.put(d);
        renderDecks();
      }),
      button('複製', async () => {
        const c = normalizeDeck(d);
        c.title = (d.title + ' のコピー').slice(0, 100);
        await DB.put(c);
        renderDecks();
      }),
      button('書き出し', () => {
        download(fileName(d.title) + '.json', new Blob([JSON.stringify(d)], { type: 'application/json' }));
      }),
      button('削除', async () => {
        if (!confirm(`「${d.title}」を削除します。元に戻せません。`)) return;
        await DB.del(d.id);
        renderDecks();
      }, 'danger'),
    );

    art.append(a, acts);
    return art;
  }));
}

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = normalizeDeck(JSON.parse(await f.text()));
    await DB.put(d);
    renderDecks();
  } catch (err) {
    alert('読み込めませんでした：' + err.message);
  }
});

renderTemplates();
renderDecks().catch(err => {
  $('#empty').hidden = false;
  $('#empty').textContent = 'このブラウザでは保存領域を使えません（' + err.message + '）';
});
