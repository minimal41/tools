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

/* 操作に失敗したときに知らせる */
function guard(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (err) { alert('うまくいきませんでした：' + Store.errorText(err)); }
  };
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
    b.addEventListener('click', guard(async () => {
      const d = newDeck(t.id);
      await Store.put(d);
      open(d.id);
    }));
    return b;
  }));
}

/* 一覧には1枚目と枚数しか無いので、デッキ全体が要る操作では読み込み直す */
async function fullDeck(id) {
  const d = await Store.get(id);
  if (!d) throw new Error('スライドが見つかりませんでした');
  return d;
}

async function renderDecks() {
  const decks = (await Store.list()).sort((a, b) => b.updated - a.updated);
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
    meta.textContent = `${d.count}枚 ・ ${fmtDate(d.updated)}`;
    a.append(makeThumb(d.first), title, meta);

    const acts = document.createElement('div');
    acts.className = 'deck-actions';
    acts.append(
      button('名前変更', guard(async () => {
        const v = prompt('スライドの名前', d.title);
        if (v == null || !v.trim()) return;
        const full = await fullDeck(d.id);
        full.title = v.trim().slice(0, 100);
        full.updated = Date.now();
        await Store.put(full);
        renderDecks();
      })),
      button('複製', guard(async () => {
        const full = await fullDeck(d.id);
        const c = normalizeDeck(full);
        c.title = (full.title + ' のコピー').slice(0, 100);
        await Store.put(c);
        renderDecks();
      })),
      button('書き出し', guard(async () => {
        const full = await fullDeck(d.id);
        download(fileName(full.title) + '.json', new Blob([JSON.stringify(full)], { type: 'application/json' }));
      })),
      button('削除', guard(async () => {
        if (!confirm(`「${d.title}」を削除します。元に戻せません。`)) return;
        await Store.del(d.id);
        renderDecks();
      }), 'danger'),
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
    await Store.put(d);
    renderDecks();
  } catch (err) {
    alert('読み込めませんでした：' + Store.errorText(err));
  }
});

/* 保存先の案内と、このブラウザに残っているスライドをアカウントへ移す */
async function renderStorage() {
  const { account, user } = await Store.ready();
  const note = $('#storageNote');
  const login = account ? account.loginUrl('../index.html', 'login') : '../login.html';

  if (!user) {
    note.replaceChildren(
      'スライドはこのブラウザの中に保存されます。',
      Object.assign(document.createElement('a'), { href: login, textContent: 'Tools のアカウントでログイン' }),
      'すると、アカウントに保存してどの端末からでも開けます。',
    );
    $('#migrate').hidden = true;
    return;
  }

  note.textContent = `スライドは Tools のアカウント（${user.displayName || user.email}）に保存されます。どの端末からでも開けます。`;

  let local = [];
  try { local = await DB.all(); } catch (e) { /* IndexedDB が使えないときは移すものも無い */ }
  $('#migrate').hidden = local.length === 0;
  if (!local.length) return;
  $('#migrateText').textContent = `このブラウザだけに保存されたスライドが ${local.length} 件あります。`;
  $('#migrateBtn').onclick = guard(async () => {
    const btn = $('#migrateBtn');
    btn.disabled = true;
    btn.textContent = '移しています…';
    try {
      for (const d of local) {
        await Store.put(d);
        await DB.del(d.id);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'アカウントに移す';
    }
    await renderDecks();
    await renderStorage();
  });
}

renderTemplates();
renderDecks().catch(err => {
  $('#empty').hidden = false;
  $('#empty').textContent = 'スライドを読み込めませんでした（' + Store.errorText(err) + '）';
});
renderStorage();
