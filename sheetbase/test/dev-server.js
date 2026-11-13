/**
 * 手元で試すためのにせサーバー。Code.gs をメモリ上のスプレッドシートで動かす。
 *   node sheetbase/test/dev-server.js        → http://localhost:8787/exec
 * データは止めると消える。
 */
const http = require('http');
const { createEnvironment } = require('./mock-gas');

const env = createEnvironment();
const port = Number(process.env.PORT) || 8787;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(env.get(Object.fromEntries(url.searchParams))));
    return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(env.sandbox.doPost({ postData: { contents: body } }).getContent());
  });
}).listen(port, () => console.log('Sheetbase dev server: http://localhost:' + port + '/exec'));
