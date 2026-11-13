/**
 * テスト:  node --test sheetbase/test/run.js
 * クライアント（sheetbase.js）→ Code.gs → にせスプレッドシート、まで通して確かめる。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnvironment } = require('./mock-gas');
const Sheetbase = require('../sheetbase.js');

function setup(options) {
  const env = createEnvironment();
  const fetch = async (url, init) => {
    assert.equal(init.headers['Content-Type'], 'text/plain;charset=utf-8');
    const text = env.sandbox.doPost({ postData: { contents: init.body } }).getContent();
    return { text: async () => text };
  };
  const client = (extra) => Sheetbase.createClient('https://example.test/exec', Object.assign({ fetch, storage: memory() }, options, extra));
  return { env, client };
}

function memory() {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: k => { delete m[k]; } };
}

async function signedIn(client, email) {
  const sb = client();
  const { error } = await sb.auth.signUp({ email, password: 'password123' });
  assert.equal(error, null);
  return sb;
}

test('ping', async () => {
  const { client } = setup();
  const { data, error } = await client().ping();
  assert.equal(error, null);
  assert.equal(data.ok, true);
});

test('書き込みはログインが必要、読むのはだれでも（既定のルール）', async () => {
  const { client } = setup();
  const anon = client();
  const denied = await anon.from('todos').insert({ title: 'x' });
  assert.equal(denied.error.code, 'unauthorized');

  const sb = await signedIn(client, 'a@example.com');
  const ins = await sb.from('todos').insert({ title: '牛乳を買う', done: false });
  assert.equal(ins.error, null);
  assert.equal(ins.data.length, 1);
  assert.ok(ins.data[0].id && ins.data[0].createdAt && ins.data[0].updatedAt);

  const read = await anon.from('todos').select();
  assert.equal(read.data.length, 1);
  assert.equal(read.data[0].title, '牛乳を買う');
  assert.equal(read.data[0].done, false);
});

test('値の型がそのまま往復する', async () => {
  const { client, env } = setup();
  const sb = await signedIn(client, 'a@example.com');
  const row = {
    str: 'hello', zero: '001', formula: '=1+1', num: 42.5, yes: true, no: false,
    nothing: null, list: [1, 'two', { three: 3 }], obj: { a: { b: 1 } }, plus: '+81-90', quote: "it's"
  };
  await sb.from('types').insert(row);
  const { data } = await sb.from('types').select().single();
  for (const k of Object.keys(row)) assert.deepEqual(data[k], row[k], k);

  // シートには式ではなく文字として入っている
  const cells = env.book.getSheetByName('types')._cells();
  const col = cells[0].indexOf('formula');
  assert.equal(cells[1][col], '=1+1');
  assert.equal(env.book.getSheetByName('types')._frozen(), 1);
});

test('シートに手で入れた日付・数は読める', async () => {
  const { client, env } = setup();
  const sheet = env.book.insertSheet('manual');
  sheet._set([
    ['id', 'when', 'n', ''],
    [1, new Date('2026-01-02T03:04:05Z'), 7, 'ignored'],
    ['', '', '', ''],
    [2, '', 9, '']
  ]);
  const { data, count } = await client().from('manual').select().order('id');
  assert.equal(count, 2);
  assert.deepEqual(data, [
    { id: 1, when: '2026-01-02T03:04:05.000Z', n: 7 },
    { id: 2, when: null, n: 9 }
  ]);
});

test('条件・並べかえ・件数・列えらび', async () => {
  const { client } = setup();
  const sb = await signedIn(client, 'a@example.com');
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push({ n: i, name: 'Item ' + i, tag: i % 2 ? 'odd' : 'even', tags: ['t' + (i % 3)] });
  const ins = await sb.from('items').insert(rows);
  assert.equal(ins.data.length, 12);

  const q = name => sb.from('items').select('n');
  const ns = async builder => (await builder).data.map(r => r.n);

  assert.deepEqual(await ns(q().eq('tag', 'even').order('n')), [2, 4, 6, 8, 10, 12]);
  assert.deepEqual(await ns(q().neq('tag', 'even').gt('n', 5).order('n')), [7, 9, 11]);
  assert.deepEqual(await ns(q().gte('n', 11).order('n')), [11, 12]);
  assert.deepEqual(await ns(q().lt('n', 3).order('n')), [1, 2]);
  assert.deepEqual(await ns(q().lte('n', 2).order('n', { ascending: false })), [2, 1]);
  assert.deepEqual(await ns(q().in('n', [3, 5, 99]).order('n')), [3, 5]);
  assert.deepEqual(await ns(q().like('name', 'Item 1%').order('n')), [1, 10, 11, 12]);
  assert.deepEqual(await ns(q().like('name', 'item 1_').order('n')), []);
  assert.deepEqual(await ns(q().ilike('name', 'item 1_').order('n')), [10, 11, 12]);
  assert.deepEqual(await ns(q().contains('tags', 't0').order('n')), [3, 6, 9, 12]);
  assert.deepEqual(await ns(q().is('missing', null).limit(2).order('n')), [1, 2]);
  assert.deepEqual(await ns(q().match({ tag: 'odd', n: 3 })), [3]);
  assert.deepEqual(await ns(q().order('tag').order('n', { ascending: false }).limit(3)), [12, 10, 8]);

  const page = await sb.from('items').select('n,name').order('n').range(5, 7);
  assert.deepEqual(page.data, [{ n: 6, name: 'Item 6' }, { n: 7, name: 'Item 7' }, { n: 8, name: 'Item 8' }]);
  assert.equal(page.count, 12);

  assert.equal((await sb.from('items').select().eq('n', 4).single()).data.name, 'Item 4');
  assert.equal((await sb.from('items').select().eq('n', 99).single()).error.code, 'not_single');
  assert.equal((await sb.from('items').select().eq('n', 99).maybeSingle()).data, null);
  assert.equal((await sb.from('items').select().single()).error.code, 'not_single');
  assert.deepEqual((await sb.from('nothing_here').select()).data, []);
});

test('update / delete / upsert', async () => {
  const { client, env } = setup();
  const sb = await signedIn(client, 'a@example.com');
  await sb.from('notes').insert([{ id: 'a', text: 'one', keep: '007' }, { id: 'b', text: 'two' }, { id: 'c', text: 'three' }]);

  assert.equal((await sb.from('notes').update({ text: 'x' })).error.code, 'bad_request');
  assert.equal((await sb.from('notes').delete()).error.code, 'bad_request');

  const up = await sb.from('notes').update({ text: 'ONE', extra: { n: 1 }, id: 'zzz', createdAt: 'hack' }).eq('id', 'a');
  assert.equal(up.error, null);
  assert.equal(up.data.length, 1);
  assert.equal(up.data[0].id, 'a');
  assert.equal(up.data[0].text, 'ONE');
  assert.deepEqual(up.data[0].extra, { n: 1 });
  assert.notEqual(up.data[0].createdAt, 'hack');

  const a = (await sb.from('notes').select().eq('id', 'a').single()).data;
  assert.equal(a.text, 'ONE');
  assert.equal(a.keep, '007', '書きかえていない列の文字はそのまま');
  assert.deepEqual(a.extra, { n: 1 });
  assert.deepEqual(up.data[0], a);
  assert.equal((await sb.from('notes').select().eq('id', 'b').single()).data.extra, null);

  const cleared = await sb.from('notes').update({ text: null }).eq('id', 'b');
  assert.equal(cleared.data[0].text, null);

  const dup = await sb.from('notes').insert({ id: 'a', text: 'again' });
  assert.equal(dup.error.code, 'conflict');

  const ups = await sb.from('notes').upsert([{ id: 'c', text: 'THREE' }, { id: 'd', text: 'four' }]);
  assert.equal(ups.error, null);
  assert.deepEqual(ups.data.map(r => [r.id, r.text]), [['c', 'THREE'], ['d', 'four']]);

  const byText = await sb.from('notes').upsert({ text: 'four', more: 1 }, { onConflict: 'text' });
  assert.equal(byText.data[0].id, 'd');
  assert.equal(byText.data[0].more, 1);

  const del = await sb.from('notes').delete().in('id', ['a', 'c']);
  assert.deepEqual(del.data.map(r => r.id).sort(), ['a', 'c']);
  const left = await sb.from('notes').select('id').order('id');
  assert.deepEqual(left.data, [{ id: 'b' }, { id: 'd' }]);
  assert.equal(env.book.getSheetByName('notes').getLastRow(), 3);
});

test('認証：登録・ログイン・ログアウト・まちがい', async () => {
  const { client, env } = setup();
  const sb = client();
  const events = [];
  sb.auth.onAuthStateChange((e, s) => events.push([e, !!s]));

  assert.equal((await sb.auth.signUp({ email: 'bad', password: 'password123' })).error.code, 'bad_request');
  assert.equal((await sb.auth.signUp({ email: 'a@example.com', password: 'short' })).error.code, 'bad_request');

  const up = await sb.auth.signUp({ email: 'A@Example.com', password: 'password123' });
  assert.equal(up.error, null);
  assert.equal(up.data.user.email, 'a@example.com');
  assert.equal(sb.auth.getUser().email, 'a@example.com');
  assert.equal((await client().auth.signUp({ email: 'a@example.com', password: 'password123' })).error.code, 'conflict');

  await sb.auth.signOut();
  assert.equal(sb.auth.getUser(), null);
  assert.equal((await sb.auth.signIn({ email: 'a@example.com', password: 'wrong-password' })).error.code, 'invalid_credentials');
  assert.equal((await sb.auth.signIn({ email: 'nobody@example.com', password: 'password123' })).error.code, 'invalid_credentials');
  const inn = await sb.auth.signIn({ email: 'a@example.com', password: 'password123' });
  assert.equal(inn.error, null);
  assert.deepEqual(events, [['SIGNED_IN', true], ['SIGNED_OUT', false], ['SIGNED_IN', true]]);

  // パスワードはそのままでは保存されない
  const users = JSON.stringify(env.book.getSheetByName('_users')._cells());
  assert.ok(!users.includes('password123'));

  // _ で始まるシートは API から見えない
  assert.equal((await sb.from('_users').select()).error.code, 'bad_request');

  // にせのトークンは通らず、クライアントはログアウトする
  const token = sb.auth.getSession().token;
  const forged = env.post({ action: 'getUser', token: token.slice(0, -3) + 'abc' });
  assert.equal(forged.error.code, 'invalid_token');
  const [body] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const evil = Buffer.from(JSON.stringify({ ...payload, id: 'someone-else' })).toString('base64url');
  assert.equal(env.post({ action: 'getUser', token: evil + '.' + token.split('.')[1] }).error.code, 'invalid_token');
  assert.equal(env.post({ action: 'getUser', token }).data.email, 'a@example.com');

  // 秘密が変わる（＝トークンが無効になる）と、次の呼び出しでログアウトする
  env.props.TOKEN_SECRET = 'rotated';
  assert.equal((await sb.from('x').select()).error.code, 'invalid_token');
  assert.equal(sb.auth.getUser(), null);
});

test('期限切れのトークンは通らない', async () => {
  const { client, env } = setup();
  env.sandbox.TOKEN_DAYS = -1;
  const sb = client();
  const up = await sb.auth.signUp({ email: 'a@example.com', password: 'password123' });
  assert.equal(env.post({ action: 'getUser', token: up.data.session.token }).error.code, 'invalid_token');
});

test('owner ルール：自分の行だけ', async () => {
  const { client, env } = setup();
  env.sandbox.RULES.todos = { read: 'owner', write: 'owner' };
  const alice = await signedIn(client, 'alice@example.com');
  const bob = await signedIn(client, 'bob@example.com');
  const aliceId = alice.auth.getUser().id;

  const a1 = await alice.from('todos').insert({ id: 'a1', title: 'alice 1', userId: 'spoof' });
  assert.equal(a1.data[0].userId, aliceId);
  await bob.from('todos').insert({ id: 'b1', title: 'bob 1' });

  assert.deepEqual((await alice.from('todos').select('id')).data, [{ id: 'a1' }]);
  assert.deepEqual((await bob.from('todos').select('id')).data, [{ id: 'b1' }]);
  assert.equal((await client().from('todos').select()).error.code, 'unauthorized');

  assert.deepEqual((await bob.from('todos').update({ title: 'hacked' }).eq('id', 'a1')).data, []);
  assert.deepEqual((await bob.from('todos').delete().eq('id', 'a1')).data, []);
  assert.equal((await bob.from('todos').upsert({ id: 'a1', title: 'hacked' })).error.code, 'forbidden');
  assert.equal((await bob.from('todos').insert({ id: 'a1', title: 'dup' })).error.code, 'conflict');
  const stolen = await alice.from('todos').update({ userId: 'bob' }).eq('id', 'a1');
  assert.equal(stolen.data[0].userId, aliceId);
  assert.equal((await alice.from('todos').select().single()).data.title, 'alice 1');
});

test('admin ルールと管理キー・API キー', async () => {
  const { client, env } = setup();
  env.sandbox.setup();
  const adminKey = env.props.ADMIN_KEY;
  assert.match(adminKey, /^sb_admin_/);
  env.sandbox.RULES.secrets = { read: 'admin', write: 'admin' };
  env.sandbox.RULES.inbox = { read: 'admin', write: 'public' };

  const user = await signedIn(client, 'a@example.com');
  assert.equal((await user.from('secrets').select()).error.code, 'forbidden');
  assert.equal((await user.from('secrets').insert({ v: 1 })).error.code, 'forbidden');
  assert.equal((await user.tables()).error.code, 'forbidden');

  const admin = client({ apiKey: adminKey });
  assert.equal((await admin.from('secrets').insert({ v: 1 })).error, null);
  assert.equal((await admin.from('secrets').select()).data.length, 1);
  assert.equal((await client().from('inbox').insert({ msg: 'hi' })).error, null);
  assert.deepEqual((await admin.tables()).data.sort(), ['inbox', 'secrets']);

  // API_KEY を設定すると、キーなしの呼び出しは全部ことわる
  env.props.API_KEY = 'pub_123';
  assert.equal((await client().ping()).error.code, 'invalid_key');
  assert.equal((await client({ apiKey: 'pub_123' }).ping()).error, null);
  assert.equal((await admin.ping()).error, null);
});

test('AUTO_SCHEMA / ALLOW_SIGNUP を切る', async () => {
  const { client, env } = setup();
  env.sandbox.setup();
  const admin = client({ apiKey: env.props.ADMIN_KEY });
  const user = await signedIn(client, 'a@example.com');
  await admin.from('fixed').insert({ id: 1, title: 'ok' });

  env.sandbox.AUTO_SCHEMA = false;
  env.sandbox.ALLOW_SIGNUP = false;
  assert.equal((await user.from('brand_new').insert({ a: 1 })).error.code, 'not_found');
  assert.equal((await user.from('fixed').insert({ title: 'ok', surprise: 1 })).error.code, 'bad_request');
  assert.equal((await user.from('fixed').update({ surprise: 1 }).eq('id', 1)).error.code, 'bad_request');
  assert.equal((await user.from('fixed').insert({ title: 'fine' })).error, null);
  assert.equal((await client().auth.signUp({ email: 'b@example.com', password: 'password123' })).error.code, 'forbidden');
  assert.equal((await admin.auth.signUp({ email: 'b@example.com', password: 'password123' })).error, null);
});

test('GET でも読める・GET では書けない', async () => {
  const { client, env } = setup();
  const sb = await signedIn(client, 'a@example.com');
  await sb.from('posts').insert([{ n: 1 }, { n: 2 }, { n: 3 }]);
  const res = env.get({ table: 'posts', order: 'n.desc', limit: '2', columns: 'n' });
  assert.deepEqual(res.data, [{ n: 3 }, { n: 2 }]);
  assert.equal(res.count, 3);
  assert.deepEqual(env.get({ table: 'posts', filters: JSON.stringify([{ col: 'n', op: 'eq', val: 2 }]), columns: 'n' }).data, [{ n: 2 }]);
  assert.equal(env.get({}).data.ok, true);
  assert.equal(env.get({ action: 'insert', table: 'posts' }).error.code, 'bad_request');
});

test('おかしなリクエスト', async () => {
  const { env, client } = setup();
  assert.equal(JSON.parse(env.sandbox.doPost({ postData: { contents: '{oops' } }).getContent()).error.code, 'bad_request');
  assert.equal(env.post({ action: 'nope' }).error.code, 'bad_request');
  assert.equal(env.post({ action: 'select' }).error.code, 'bad_request');
  assert.equal(env.post({ action: 'select', table: 't', filters: [{ col: 'a', op: 'drop' }] }).error.code, 'bad_request');
  const sb = await signedIn(client, 'a@example.com');
  assert.equal((await sb.from('t').insert([])).error.code, 'bad_request');
  assert.equal((await sb.from('t').insert('text')).error.code, 'bad_request');
  assert.equal((await sb.from('t').insert(new Array(501).fill({ a: 1 }))).error.code, 'bad_request');
});

test('通信できないときも例外にせず error で返す', async () => {
  const sb = Sheetbase.createClient('https://example.test/exec', {
    storage: memory(),
    fetch: async () => { throw new Error('offline'); }
  });
  assert.equal((await sb.from('t').select()).error.code, 'network');
  const html = Sheetbase.createClient('https://example.test/exec', {
    storage: memory(),
    fetch: async () => ({ text: async () => '<html>login</html>' })
  });
  assert.equal((await html.ping()).error.code, 'bad_response');
});

test('subscribe：変わったときだけ呼ばれ、止められる', async () => {
  const { client } = setup();
  const sb = await signedIn(client, 'a@example.com');
  const realSetTimeout = global.setTimeout;
  const pending = [];
  global.setTimeout = fn => { pending.push(fn); return pending.length; };
  const flush = () => new Promise(r => setImmediate(r));
  try {
    const seen = [];
    const stop = sb.from('feed').select('n').order('n').subscribe(res => seen.push(res.data.map(r => r.n)));
    await flush();
    assert.deepEqual(seen, [[]]);
    pending.shift()(); await flush();
    assert.deepEqual(seen, [[]], '変わっていなければ呼ばれない');
    await sb.from('feed').insert({ n: 1 });
    pending.shift()(); await flush();
    assert.deepEqual(seen, [[], [1]]);
    stop();
    await sb.from('feed').insert({ n: 2 });
    (pending.shift() || (() => {}))(); await flush();
    assert.deepEqual(seen, [[], [1]]);
  } finally {
    global.setTimeout = realSetTimeout;
  }
});
