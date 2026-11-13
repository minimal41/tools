/**
 * Google Apps Script のまねをして、Code.gs を Node の中で動かす（テスト・手元確認用）。
 * スプレッドシートはメモリの中の 2 次元配列。
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createSheet(name) {
  let cells = []; // cells[row][col]
  let frozen = 0;

  // セルに入れるときのスプレッドシートのふるまい：先頭の ' は「文字のまま」の印で、値には残らない
  const store = v => (typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v);

  const sheet = {
    getName: () => name,
    getLastRow: () => {
      for (let r = cells.length - 1; r >= 0; r--) if ((cells[r] || []).some(v => v !== '' && v != null)) return r + 1;
      return 0;
    },
    getLastColumn: () => {
      let max = 0;
      cells.forEach(row => (row || []).forEach((v, c) => { if (v !== '' && v != null) max = Math.max(max, c + 1); }));
      return max;
    },
    getRange: (row, col, numRows = 1, numCols = 1) => ({
      getValues: () => {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) {
            const v = (cells[row - 1 + r] || [])[col - 1 + c];
            line.push(v == null ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      setValues: values => {
        if (values.length !== numRows || values.some(l => l.length !== numCols)) {
          throw new Error('The number of rows/columns in the data does not match the range');
        }
        values.forEach((line, r) => {
          const target = (cells[row - 1 + r] = cells[row - 1 + r] || []);
          line.forEach((v, c) => { target[col - 1 + c] = store(v); });
        });
      }
    }),
    deleteRow: row => { cells.splice(row - 1, 1); },
    setFrozenRows: n => { frozen = n; },
    // テスト用
    _cells: () => cells,
    _set: next => { cells = next; },
    _frozen: () => frozen
  };
  return sheet;
}

function createEnvironment() {
  const sheets = [];
  const props = {};

  const book = {
    getSheetByName: n => sheets.find(s => s.getName() === n) || null,
    insertSheet: n => { const s = createSheet(n); sheets.push(s); return s; },
    getSheets: () => sheets.slice()
  };

  const toBytes = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b)); // Apps Script は符号つきバイト
  const fromBytes = arr => Buffer.from(arr.map(b => (b + 256) % 256));
  const webSafe = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ setMimeType() { return this; }, getContent: () => text })
    },
    Utilities: {
      Charset: { UTF_8: 'utf8' },
      DigestAlgorithm: { SHA_256: 'sha256' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, text) => toBytes(crypto.createHash(alg).update(text, 'utf8').digest()),
      computeHmacSha256Signature: (text, key) => toBytes(crypto.createHmac('sha256', key).update(text, 'utf8').digest()),
      base64EncodeWebSafe: data => webSafe(typeof data === 'string' ? Buffer.from(data, 'utf8') : fromBytes(data)),
      base64DecodeWebSafe: text => toBytes(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: bytes => ({ getDataAsString: () => fromBytes(bytes).toString('utf8') })
    },
    Logger: { log() {} }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });

  return {
    sandbox,
    book,
    props,
    /** POST と同じ道を通す */
    post: body => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
    get: parameter => JSON.parse(sandbox.doGet({ parameter }).getContent())
  };
}

module.exports = { createEnvironment };
