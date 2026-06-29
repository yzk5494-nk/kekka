const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = require('puppeteer-core'); }

// 設定読み込み
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'wp-config.json'), 'utf8'));
const WP_URL = config.url;
const AUTH = Buffer.from(`${config.username}:${config.password}`).toString('base64');

// Xポストライブラリ
const X_LIBRARY_FILE = path.join(__dirname, 'x-library.json');
function readXLibrary() {
  try { return JSON.parse(fs.readFileSync(X_LIBRARY_FILE, 'utf8')); }
  catch { return { posts: [], lastFetched: {} }; }
}
function writeXLibrary(data) {
  fs.writeFileSync(X_LIBRARY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function fetchXPostsForAccount(userName) {
  const apiKey = config.twitterapi_key;
  if (!apiKey || apiKey.includes('ここに')) { console.log('[x] APIキー未設定'); return []; }

  const collected = [];
  let cursor = '';
  for (let page = 0; page < 3; page++) {
    const qs = `userName=${encodeURIComponent(userName)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: 'api.twitterapi.io', path: `/twitter/user/last_tweets?${qs}`, method: 'GET',
          headers: { 'X-API-Key': apiKey } },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch(e) { reject(e); }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    const tweets = result.data?.tweets || result.tweets;
    if (!Array.isArray(tweets)) break;
    tweets.forEach(t => {
      if (!t.isReply) collected.push({
        id: t.id,
        text: t.text,
        url: t.url || `https://x.com/${userName}/status/${t.id}`,
        createdAt: t.createdAt,
        account: userName,
      });
    });
    const hasNext = result.data?.has_next_page ?? result.has_next_page;
    const nextCursor = result.data?.next_cursor ?? result.next_cursor;
    if (!hasNext) break;
    cursor = nextCursor;
  }
  return collected;
}

async function syncXLibrary() {
  const accounts = config.x_accounts || [];
  if (!accounts.length) return;
  console.log('[x] 取得開始:', accounts);
  const lib = readXLibrary();
  const existingIds = new Set(lib.posts.map(p => p.id));
  let added = 0;
  for (const account of accounts) {
    try {
      const posts = await fetchXPostsForAccount(account);
      posts.forEach(p => {
        if (!existingIds.has(p.id)) { lib.posts.push(p); existingIds.add(p.id); added++; }
      });
      lib.lastFetched[account] = new Date().toISOString();
      console.log(`[x] @${account}: ${posts.length}件取得`);
    } catch(e) { console.error(`[x] @${account} エラー:`, e.message); }
  }
  // 古い投稿は3000件を超えたら古い順に削除
  if (lib.posts.length > 3000) lib.posts = lib.posts.slice(lib.posts.length - 3000);
  writeXLibrary(lib);
  console.log(`[x] 同期完了 新規${added}件 合計${lib.posts.length}件`);
}

// 起動時に1回 + 1時間ごとに自動取得
setTimeout(syncXLibrary, 5000);
setInterval(syncXLibrary, 60 * 60 * 1000);

// 店舗記憶ファイル
const STORE_MEMORY_FILE = path.join(__dirname, 'store-memory.json');
function readStoreMemory() {
  try { return JSON.parse(fs.readFileSync(STORE_MEMORY_FILE, 'utf8')); } catch { return {}; }
}
function writeStoreMemory(data) {
  fs.writeFileSync(STORE_MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// hisshobon-hall.info 設定
const HB = config.hisshobon;
const HB_AUTH = Buffer.from(`${HB.username}:${HB.password}`).toString('base64');

// yg-blog.com 設定
const YG = config.yg;
const YG_AUTH = Buffer.from(`${YG.username}:${YG.password}`).toString('base64');

// hisshobon-hall.info REST API リクエスト
function hbRequest(method, endpoint, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(HB.url + '/wp-json/wp/v2/' + endpoint);
    const headers = { 'Authorization': `Basic ${HB_AUTH}`, ...extraHeaders };

    let bodyBuffer = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        bodyBuffer = body;
      } else {
        bodyBuffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = bodyBuffer.length;
    }

    const req = https.request(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, data: raw }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

// yg-blog.com REST API リクエスト
function ygRequest(method, endpoint, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(YG.url + '/wp-json/wp/v2/' + endpoint);
    const headers = { 'Authorization': `Basic ${YG_AUTH}`, ...extraHeaders };

    let bodyBuffer = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        bodyBuffer = body;
      } else {
        bodyBuffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = bodyBuffer.length;
    }

    const req = https.request(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, data: raw }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

const PORT = process.env.PORT || 3000;

// WordPress REST API リクエスト
function wpRequest(method, endpoint, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(WP_URL + '/wp-json/wp/v2/' + endpoint);
    const headers = {
      'Authorization': `Basic ${AUTH}`,
      ...extraHeaders,
    };

    let bodyBuffer = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        bodyBuffer = body;
      } else {
        bodyBuffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = bodyBuffer.length;
    }

    const req = https.request(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, data: raw }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

// リクエストボディを Buffer として収集
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// カテゴリー全件取得（ページング対応）
async function fetchAllCategories() {
  const first = await wpRequest('GET', 'categories?per_page=100&page=1');
  const totalPages = parseInt(first.headers['x-wp-totalpages'] || '1', 10);
  let all = Array.isArray(first.data) ? first.data : [];
  for (let p = 2; p <= totalPages; p++) {
    const r = await wpRequest('GET', `categories?per_page=100&page=${p}`);
    if (Array.isArray(r.data)) all = all.concat(r.data);
  }
  return all;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  parsed.query = Object.fromEntries(parsed.searchParams);

  const sendJson = (status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  try {
    // ── UI ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && parsed.pathname === '/wp-poster') {
      const html = fs.readFileSync(path.join(__dirname, 'wp-poster.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && parsed.pathname === '/stores') {
      const html = fs.readFileSync(path.join(__dirname, 'stores.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && parsed.pathname === '/yg-poster') {
      const html = fs.readFileSync(path.join(__dirname, 'yg-poster.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && parsed.pathname === '/article-generator') {
      const html = fs.readFileSync(path.join(__dirname, 'article-generator.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // ── 静的ファイル（xlsx ライブラリ） ──────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/node_modules/xlsx/dist/xlsx.full.min.js') {
      const filePath = path.join(__dirname, 'node_modules/xlsx/dist/xlsx.full.min.js');
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(content);
    }

    // ── 静的ファイル（library-data.json） ────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/library-data.json') {
      const filePath = path.join(__dirname, 'library-data.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(content);
      }
      res.writeHead(404); return res.end('Not found');
    }

    // ── カテゴリー一覧 ───────────────────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/categories') {
      const cats = await fetchAllCategories();
      return sendJson(200, cats);
    }

    // ── hisshobon 画像アップロード ────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/upload-hb-media') {
      const buf = await collectBody(req);
      const { filename, data: base64 } = JSON.parse(buf.toString('utf8'));
      const imgBuf = Buffer.from(base64, 'base64');
      const base = filename.replace(/\.png$/i, '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      const finalFilename = (base || `image_${Date.now()}`) + '.png';
      const r = await hbRequest('POST', 'media', imgBuf, {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${finalFilename}"`,
      });
      console.log(`[hb-upload] status=${r.status} filename=${finalFilename} response=`, JSON.stringify(r.data).slice(0, 300));
      return sendJson(r.status, r.data);
    }

    // ── 画像アップロード ─────────────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/upload-media') {
      const buf = await collectBody(req);
      const { filename, data: base64 } = JSON.parse(buf.toString('utf8'));
      const imgBuf = Buffer.from(base64, 'base64');

      // ファイル名を英数字のみに変換（日本語除去、空の場合はタイムスタンプ）
      const base = filename.replace(/\.png$/i, '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      const finalFilename = (base || `image_${Date.now()}`) + '.png';

      const r = await wpRequest('POST', 'media', imgBuf, {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${finalFilename}"`,
      });
      console.log(`[upload] status=${r.status} filename=${finalFilename} response=`, JSON.stringify(r.data).slice(0, 300));
      return sendJson(r.status, r.data);
    }

    // ── 記事作成（下書き）────────────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/create-post') {
      const buf = await collectBody(req);
      const postData = JSON.parse(buf.toString('utf8'));
      const r = await wpRequest('POST', 'posts', postData);
      return sendJson(r.status, r.data);
    }

    // ── ランク画像ローカル保存 ────────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/save-rank-image') {
      const buf = await collectBody(req);
      const { rank, data: base64, ext } = JSON.parse(buf.toString('utf8'));
      const dir = path.join(__dirname, 'rank-images');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      const filename = `rank${rank}.${ext || 'png'}`;
      fs.writeFileSync(path.join(dir, filename), Buffer.from(base64, 'base64'));
      return sendJson(200, { url: `/rank-images/${filename}` });
    }

    // ── ランク画像静的配信 ───────────────────────────────────────────
    if (req.method === 'GET' && parsed.pathname.startsWith('/rank-images/')) {
      const filename = path.basename(parsed.pathname);
      const filePath = path.join(__dirname, 'rank-images', filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        const mime = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    // ── 機種画像ローカル保存 ─────────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/save-machine-image') {
      const buf = await collectBody(req);
      const { filename, data: base64 } = JSON.parse(buf.toString('utf8'));
      const dir = path.join(__dirname, 'machine-images');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      const safeName = filename.replace(/[^\w.\-]/g, '_');
      fs.writeFileSync(path.join(dir, safeName), Buffer.from(base64, 'base64'));
      return sendJson(200, { url: `/machine-images/${safeName}` });
    }

    // ── 機種画像静的配信 ─────────────────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/assets/jag-header.jpg') {
      const filePath = path.join(__dirname, 'ジャグ系設置台数.jpg');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/ifudodo.jpg') {
      const filePath = path.join(__dirname, '威風堂々.jpg');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/samy-header.jpg') {
      const filePath = path.join(__dirname, 'サミー系機種.jpg');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/sankyo-header.jpg') {
      const filePath = path.join(__dirname, 'SANKYO系機種.jpg');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/tokyoghoul.png') {
      const filePath = path.join(__dirname, '東京喰種.png');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/tokyoghoul-header.png') {
      const filePath = path.join(__dirname, '東京喰種ヘッダー.png');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/hyakkaryoran.png') {
      const filePath = path.join(__dirname, '百花繚乱.png');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/hyakkaryoran-header.png') {
      const filePath = path.join(__dirname, '百花繚乱ヘッダー.png');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/ikkyunyukon.png') {
      const filePath = path.join(__dirname, '一球入魂.png');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/ikkyunyukon-header.png') {
      const filePath = path.join(__dirname, '一球入魂ヘッダー.png');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname === '/assets/shishifunjin.jpg') {
      const filePath = path.join(__dirname, '獅子奮迅.jpg');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method === 'GET' && parsed.pathname.startsWith('/machine-images/')) {
      const filename = path.basename(parsed.pathname);
      const filePath = path.join(__dirname, 'machine-images', filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        const mime = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    // ── hisshobon メディアライブラリ ────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hisshobon-media') {
      const page     = parsed.query.page     || 1;
      const perPage  = parsed.query.per_page || 30;
      const search   = parsed.query.search   || '';
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const r = await hbRequest('GET', `media?per_page=${perPage}&page=${page}&media_type=image&orderby=date&order=desc${searchParam}`);
      const total      = r.headers['x-wp-total']      || 0;
      const totalPages = r.headers['x-wp-totalpages'] || 1;
      return sendJson(r.status, { items: r.data, total, totalPages });
    }

    // ── 記事ジェネレーター用ライブラリ（article-data/library.json）──
    if (req.method === 'GET' && parsed.pathname === '/api/article-library') {
      const libPath = path.join(__dirname, 'article-data', 'library.json');
      if (fs.existsSync(libPath)) {
        const data = fs.readFileSync(libPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(data);
      } else {
        return sendJson(200, { images: {}, stores: {}, prevTop1: {} });
      }
    }
    if (req.method === 'POST' && parsed.pathname === '/api/article-library') {
      const buf = await collectBody(req);
      const libPath = path.join(__dirname, 'article-data', 'library.json');
      fs.writeFileSync(libPath, buf.toString('utf8'), 'utf8');
      return sendJson(200, { ok: true });
    }

    // ── 優秀台ピックアップ用ライブラリ（pickup-data/library.json）──
    if (req.method === 'GET' && parsed.pathname === '/api/pickup-library') {
      const libPath = path.join(__dirname, 'pickup-data', 'library.json');
      if (fs.existsSync(libPath)) {
        const data = fs.readFileSync(libPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(data);
      } else {
        return sendJson(200, { images: {}, nicknames: {} });
      }
    }
    if (req.method === 'POST' && parsed.pathname === '/api/pickup-library') {
      const buf = await collectBody(req);
      const libPath = path.join(__dirname, 'pickup-data', 'library.json');
      fs.writeFileSync(libPath, buf.toString('utf8'), 'utf8');
      return sendJson(200, { ok: true });
    }

    // ── 旧エンドポイント（後方互換）────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/library') {
      const libPath = path.join(__dirname, 'library-data.json');
      if (fs.existsSync(libPath)) {
        const data = fs.readFileSync(libPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(data);
      } else {
        return sendJson(200, { images: {}, nicknames: {} });
      }
    }
    if (req.method === 'POST' && parsed.pathname === '/api/library') {
      const buf = await collectBody(req);
      const libPath = path.join(__dirname, 'library-data.json');
      fs.writeFileSync(libPath, buf.toString('utf8'), 'utf8');
      return sendJson(200, { ok: true });
    }

    // ── Xポスト検索 ──────────────────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/x-posts') {
      const q = (parsed.query.q || '').toLowerCase();
      const account = parsed.query.account || '';
      const lib = readXLibrary();
      let posts = lib.posts;
      if (account) posts = posts.filter(p => p.account === account);
      if (q) posts = posts.filter(p => p.text.toLowerCase().includes(q));
      // 新しい順に最大50件
      posts = posts.slice().reverse().slice(0, 50);
      return sendJson(200, { posts, lastFetched: lib.lastFetched, total: lib.posts.length });
    }

    // ── Xポスト手動取得 ──────────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/fetch-x-posts') {
      syncXLibrary().catch(e => console.error('[x] 手動取得エラー:', e.message));
      return sendJson(200, { ok: true, message: '取得開始しました（バックグラウンド実行中）' });
    }

    // ── YG カテゴリー一覧 ────────────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/yg-categories') {
      const first = await ygRequest('GET', 'categories?per_page=100&page=1');
      const totalPages = parseInt(first.headers?.['x-wp-totalpages'] || '1', 10);
      let all = Array.isArray(first.data) ? first.data : [];
      for (let p = 2; p <= totalPages; p++) {
        const r = await ygRequest('GET', `categories?per_page=100&page=${p}`);
        if (Array.isArray(r.data)) all = all.concat(r.data);
      }
      return sendJson(200, all);
    }

    // ── YG カテゴリー新規作成 ──────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/create-yg-category') {
      const buf = await collectBody(req);
      const { name, parent } = JSON.parse(buf.toString('utf8'));
      if (!name || !name.trim()) return sendJson(400, { error: 'カテゴリー名を入力してください' });
      const r = await ygRequest('POST', 'categories', { name: name.trim(), parent: parent || 0 });
      console.log(`[yg-category] status=${r.status} name="${name}" parent=${parent || 0}`);
      return sendJson(r.status, r.data);
    }

    // ── YG 画像アップロード ──────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/upload-yg-media') {
      const buf = await collectBody(req);
      const { filename, data: base64 } = JSON.parse(buf.toString('utf8'));
      const imgBuf = Buffer.from(base64, 'base64');
      const base = filename.replace(/\.png$/i, '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      const finalFilename = (base || `image_${Date.now()}`) + '.png';
      const r = await ygRequest('POST', 'media', imgBuf, {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${finalFilename}"`,
      });
      console.log(`[yg-upload] status=${r.status} filename=${finalFilename}`);
      return sendJson(r.status, r.data);
    }

    // ── YG 記事投稿 ──────────────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/create-yg-post') {
      const buf = await collectBody(req);
      const postData = JSON.parse(buf.toString('utf8'));
      const r = await ygRequest('POST', 'posts', postData);
      console.log(`[yg-post] status=${r.status} title="${postData.title}"`);
      return sendJson(r.status, r.data);
    }

    // ── p-world 台数スクレイピング ───────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/scrape-pworld') {
      const buf = await collectBody(req);
      const { pageUrl, keywords } = JSON.parse(buf.toString('utf8'));
      if (!pageUrl || !pageUrl.includes('p-world.co.jp')) {
        return sendJson(400, { error: 'p-worldのURLを入力してください' });
      }
      const filterKeywords = (keywords && keywords.length) ? keywords : [];

      let browser;
      try {
        const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
        if (process.platform === 'win32') launchOpts.executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // 機種リストのJS描画完了を待つ
        await page.waitForSelector('li.js-hallKisyuList-item', { timeout: 15000 })
          .catch(() => console.warn('[pworld] js-hallKisyuList-item が見つかりませんでした'));

        // スロット機種取得（aタグのテキストを機種名に使う・台数は取得不可のため0）
        const allSlot = await page.evaluate(() => {
          const results = [];
          const seen = new Set();
          document.querySelectorAll('li[data-machine-type="S"]').forEach(li => {
            // aタグのテキストが一番きれいな機種名
            const name = (li.querySelector('a')?.innerText || li.dataset.machineName || '').split('/')[0].trim();
            if (!name || seen.has(name)) return;
            seen.add(name);
            results.push({ name, count: 0 });
          });
          return results;
        });

        // キーワードフィルター
        const machines = filterKeywords.length
          ? allSlot.filter(m => filterKeywords.some(kw => m.name.includes(kw)))
          : allSlot;

        console.log(`[pworld] 全スロット: ${allSlot.length}件, フィルター後: ${machines.length}件`);
        console.log('[pworld] 取得例:', machines.slice(0, 5));
        return sendJson(200, { machines });
      } catch(e) {
        console.error('[pworld] error:', e.message);
        return sendJson(500, { error: e.message });
      } finally {
        if (browser) await browser.close();
      }
    }

    // ── p-town(DMM) スクレイピング ────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/scrape-ptown') {
      const buf = await collectBody(req);
      const { pageUrl } = JSON.parse(buf.toString('utf8'));
      if (!pageUrl) return sendJson(400, { error: 'pageUrl が必要です' });

      let browser;
      try {
        const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
        if (process.platform === 'win32') launchOpts.executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // 機種リスト描画を待つ
        await page.waitForSelector('a[href*="/machines/"]', { timeout: 15000 })
          .catch(() => console.warn('[ptown] 機種リストが見つかりませんでした'));

        // スロット機種名と台数を取得
        const { machines, debugCategories } = await page.evaluate(() => {
          const results = [];
          const slotAnchor = document.getElementById('anc-slot');
          const slotSection = slotAnchor?.closest('section') || slotAnchor?.parentElement;
          if (!slotSection) return { machines: results, debugCategories: [] };

          // セクション内の全要素を順番に走査し、直前のh4をカテゴリとして追跡
          let currentCategory = '';
          const machineCategory = new Map();
          const debugCategories = [];

          const walker = document.createTreeWalker(slotSection, NodeFilter.SHOW_ELEMENT);
          let node = walker.nextNode();
          while (node) {
            if (/^H[1-6]$/.test(node.tagName)) {
              currentCategory = (node.innerText || node.textContent || '').trim();
              if (!debugCategories.includes(currentCategory)) debugCategories.push(currentCategory);
            }
            if (node.tagName === 'A' && /\/machines\/\d+/.test(node.getAttribute('href') || '')) {
              machineCategory.set(node, currentCategory);
            }
            node = walker.nextNode();
          }

          slotSection.querySelectorAll('a[href*="/machines/"]').forEach(a => {
            if (!/\/machines\/\d+/.test(a.getAttribute('href'))) return;
            const name = a.innerText?.trim();
            if (!name?.includes('ジャグ')) return;

            const category = machineCategory.get(a) || '';
            if (category.includes('178') || category.includes('160') || category.includes('188') || category.includes('2.5') || category.includes('２.５') || category.includes('5.495') || category.includes('５.４９５') || category.includes('[5]') || category.includes('[５]')) return;

            const li = a.closest('li');
            const liText = li?.innerText || '';
            const countMatch = liText.replace(name, '').match(/(\d+)/);
            const count = countMatch ? parseInt(countMatch[1]) : 0;
            if (count > 0) results.push({ name, count });
          });
          return { machines: results, debugCategories };
        });

        console.log(`[ptown] 取得: ${machines.length}機種, カテゴリー: ${debugCategories.join(', ')}`);
        return sendJson(200, { machines, debugCategories });
      } catch(e) {
        console.error('[ptown] error:', e.message);
        return sendJson(500, { error: e.message });
      } finally {
        if (browser) await browser.close();
      }
    }

    // ── hisshobon カテゴリー一覧（全件） ───────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hb-categories') {
      const first = await hbRequest('GET', 'categories?per_page=100&page=1');
      const totalPages = parseInt(first.headers?.['x-wp-totalpages'] || '1', 10);
      let all = Array.isArray(first.data) ? first.data : [];
      for (let p = 2; p <= totalPages; p++) {
        const r = await hbRequest('GET', `categories?per_page=100&page=${p}`);
        if (Array.isArray(r.data)) all = all.concat(r.data);
      }
      return sendJson(200, all);
    }

    // ── hisshobon ホール一覧（店舗カテゴリーのみ抽出） ─────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hb-halls') {
      const PREF_MAP = {
        hokkaido:'北海道',aomori:'青森県',iwate:'岩手県',miyagi:'宮城県',akita:'秋田県',
        yamagata:'山形県',fukushima:'福島県',ibaraki:'茨城県',tochigi:'栃木県',
        gunma:'群馬県',saitama:'埼玉県',chiba:'千葉県',tokyo:'東京都',kanagawa:'神奈川県',
        niigata:'新潟県',nagano:'長野県',yamanashi:'山梨県',
        toyama:'富山県',ishikawa:'石川県',fukui:'福井県',
        shizuoka:'静岡県',aichi:'愛知県',gifu:'岐阜県',mie:'三重県',
        osaka:'大阪府',kyoto:'京都府',hyogo:'兵庫県',nara:'奈良県',
        shiga:'滋賀県',wakayama:'和歌山県',
        tottori:'鳥取県',shimane:'島根県',okayama:'岡山県',hiroshima:'広島県',yamaguchi:'山口県',
        tokushima:'徳島県',kagawa:'香川県',ehime:'愛媛県',kochi:'高知県',
        fukuoka:'福岡県',saga:'佐賀県',nagasaki:'長崎県',kumamoto:'熊本県',
        oita:'大分県',miyazaki:'宮崎県',kagoshima:'鹿児島県',okinawa:'沖縄県',
      };
      const first = await hbRequest('GET', 'categories?per_page=100&page=1');
      const totalPages = parseInt(first.headers?.['x-wp-totalpages'] || '1', 10);
      let all = Array.isArray(first.data) ? first.data : [];
      for (let p = 2; p <= totalPages; p++) {
        const r = await hbRequest('GET', `categories?per_page=100&page=${p}`);
        if (Array.isArray(r.data)) all = all.concat(r.data);
      }
      // 子を持つカテゴリーIDのセット（地域・都道府県）を除外し、葉ノード＝店舗のみ抽出
      const parentIds = new Set(all.map(c => c.parent).filter(Boolean));
      const halls = all.filter(c => !parentIds.has(c.id) && c.parent !== 0).map(c => {
        const parts = new URL(c.link).pathname.replace(/^\/category\//, '').replace(/\/$/, '').split('/');
        // 3階層（地域/県/店舗）or 2階層（地域/店舗 = 北海道など）
        const prefSlug = parts.length >= 3 ? parts[1] : parts[0];
        return { id: c.id, name: c.name, link: c.link, pref: PREF_MAP[prefSlug] || prefSlug };
      });
      return sendJson(200, halls);
    }

    // ── hisshobon タグ一覧（全件） ──────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hb-tags') {
      const first = await hbRequest('GET', 'tags?per_page=100&page=1');
      const totalPages = parseInt(first.headers?.['x-wp-totalpages'] || '1', 10);
      let all = Array.isArray(first.data) ? first.data : [];
      for (let p = 2; p <= totalPages; p++) {
        const r = await hbRequest('GET', `tags?per_page=100&page=${p}`);
        if (Array.isArray(r.data)) all = all.concat(r.data);
      }
      return sendJson(200, all);
    }

    // ── hisshobon レポート投稿 ──────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/create-hb-post') {
      const buf = await collectBody(req);
      const { title, content, status, categories, tags, featured_media } = JSON.parse(buf.toString('utf8'));
      const body = { title, content, status: status || 'draft' };
      if (categories && categories.length) body.categories = categories;
      if (tags && tags.length) body.tags = tags;
      if (featured_media) body.featured_media = featured_media;
      const r = await hbRequest('POST', 'report', body);
      console.log(`[hb-report] status=${r.status} title="${title}"`);
      return sendJson(r.status, r.data);
    }

    // ── hisshobon ポストタイプ一覧（調査用） ───────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hb-types') {
      const r = await hbRequest('GET', 'types');
      return sendJson(r.status, r.data);
    }

    // ── Claude API で文章生成 ──────────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/generate-text') {
      const apiKey = config.claude_api_key;
      if (!apiKey) return sendJson(400, { error: 'wp-config.json に claude_api_key が設定されていません' });

      const buf = await collectBody(req);
      const data = JSON.parse(buf.toString('utf8'));

      const now = new Date();
      const month = `${now.getFullYear()}年${now.getMonth()+1}月`;

      const tones = [
        'テンション高め・感嘆符多め・勢いのある語尾（〜ましたーっ！など）',
        'ユーモアを交えながら親しみやすく・軽快なテンポで',
        'やや落ち着いたトーンだが熱量はしっかり伝わる文体で',
        '比喩や慣用句を積極的に使って格調高く',
        '読者に語りかけるような口語調で・絵文字を多めに',
        '興奮気味・驚き表現を前面に出して臨場感たっぷりに',
      ];
      const todayTone = tones[Math.floor(Math.random() * tones.length)];

      const prompt = `あなたはパチスロ専門誌「パチ＆スロ必勝本」の取材ライター「新人編集のマモル」です。
ジャグラー系機種取材レポート【戦極～電光石火～】の吹き出しテキストを生成してください。
【今回の文体方針】${todayTone}

【今回の取材情報】
- 取材日: ${month}
- 店舗: ${data.pref}・${data.city}市【${data.hall}】
- 前回最多機種: ${data.prev}
- 設置台数: ${data.machineList}（${data.cnt}機種 合計${data.total}台、最多:${data.main}）
- 差枚数RANK1: 【${data.t1n}・${data.t1num}番台】${data.t1d}
- 差枚数RANK2: 【${data.t2n}・${data.t2num}番台】${data.t2d}
- 差枚数RANK3: 【${data.t3n}・${data.t3num}番台】${data.t3d}
- ランクイン台数トップ: ${data.rankInTop || '不明'}
${data.gassoTop ? `- 合算確率トップ: ${data.gassoTop}` : ''}

【文体・トーンのルール】
- テンション高め・フレンドリー・絵文字を適度に使用
- 「〜ですっ」「〜ましたーっ」など語尾に勢いがある
- 「コチラ」「アツい」など独特の表記あり
- 毎回少しずつ違う表現・言い回しにすること

【各キーの実例（参考にしてバリエーションを作ること）】

■ b3（【戦極～電光石火～】の形容。慣用句＋イベント名の形）
実例:
- 「回を重ねるに連れて好評を博している【戦極～電光石火～】🤡」
- 「破竹の勢いで規模を拡大している【戦極～電光石火～】」
- 「一気呵成の勢いで規模を拡大している【戦極～電光石火～】🤡」
- 「飛ぶ鳥を落とす勢いで規模を拡大している【戦極～電光石火～】」
- 「回を増す毎に好評を博している【戦極～電光石火～】🤡」
- 「破竹の勢いで広がり続けている【戦極～電光石火～】」
→ 慣用句・比喩表現を変えて1文で。

■ b5（全国参戦告知）
実例:
- 「今月も全国で名を馳せるジャグラー自慢ホールの40店舗以上が参戦‼️各地で熱戦を繰り広げていますっっ⚔️」
- 「${month}も全国津々浦々の有名ホール・約50店舗が集結っ‼️各地で熱い戦いを繰り広げていますよ⚔️⚔️⚔️」
- 「今月も全国で名を馳せるジャグ自慢ホールが約50店舗も参戦‼️各地で熱戦を繰り広げて参りますっ⚔️」
→ 店舗数（40〜50店舗）・月・表現を少し変えて。1〜2文。

${data.firstTime ? `■ b6（初開催）
実例:
- 「いよいよ同店に【戦極～電光石火～】が初上陸🎉どの機種から優秀台が飛び出すのか、期待MAXで参戦してきましたーっ✨」
- 「記念すべき初開催となった同店での【戦極～電光石火～】⚔️ジャグラー自慢のこのお店、いったいどんな結果が待っているのでしょうか⁉️」
- 「満を持して【戦極～電光石火～】が初登場🔥さあ、同店のジャグラーはどこまでやってくれるのか！目が離せませんっ✨」
- 「ついに初陣を迎えた同店での【戦極～電光石火～】🎊前評判通りの盛り上がりが見られるのか、ドキドキしながら参戦してきましたよっ✨」
- 「同店では今回が初の【戦極～電光石火～】開催‼️どの機種がこの記念すべき第1回の主役に輝くのか、楽しみで仕方ありませんっ🔥」
→ 「初上陸」「初開催」「初登場」「初陣」など"初めて"の表現を使い、期待感を前面に出した1〜2文にすること。前回機種には触れない。` : `■ b6（前回振り返り＆今回への期待）
実例:
- 「前回は${data.prev}が優勢でしたが、果たしてどの機種から優秀台が現れるのでしょうか⁉️」
- 「コチラの店舗ではお馴染みとなった【戦極〜電光石火〜】🎉前回は${data.prev}に絶好調な挙動を示す台が見つかり盛り上がりましたが、今回はどうなるか！」
- 「前回は${data.prev}を筆頭に盛り上がっていましたが、今回はどの機種が1位となるのか楽しみですね✨️」
- 「前回に引き続き${data.prev}が連覇を飾るのか、それとも他機種の刺客が現れるのか⁉️ドキドキが止まりませんっ✨」
- 「${data.prev}が輝いた前回から一転、今回はどんなドラマが待ち受けているのでしょうか🎯目が離せませんね‼️」
- 「前回は${data.prev}がランキングを席巻していましたが、今回もその覇権が続くのか、それとも新星が誕生するのか⁉️」
- 「前回取材では${data.prev}が大活躍でしたが、今回はどの機種が頂点に立つのか、期待が膨らみますねっ🎊」
- 「前回は${data.prev}が存在感を放っていましたね🤔果たして今回もその勢いは続くのか、それとも大逆転劇が待っているのか⁉️」
- 「前回の${data.prev}旋風からどう変わるのか⁉️今回のランキングも目が離せませんよ🔥」
- 「前回は${data.prev}が頭一つ抜け出していましたが、今回はその流れを受け継ぐ機種が現れるのか注目ですっ✨」
- 「${data.prev}が躍動した前回の余韻も冷めやらぬ中、今回はいったいどの機種から優秀台が飛び出すのか⁉️楽しみですね～🎉」
→ 前回機種(${data.prev})に必ず触れて今回への期待を。1〜2文。上記のどれかをベースにバリエーションを出すこと。`}

■ b13（TOP結果への詳細コメント）
実例:
- 「1位の${data.t1n}はなんと${data.t1d.replace(/\+/,'')}オーバーという結果に😲ジャグラーでこの枚数、この当たり方はさぞ楽しかった事でしょう✨また2位の${data.t2n}も差枚数${data.t2d.replace(/\+/,'')}とこちらも素晴らしい結果でした‼️」
- 「上位はゲーム数も合成確率も出玉も全て申し分ないぐらい盛り上がりましたね✨ランキング内の台は全て合成確率が超優秀という結果👏👏👏」
- 「いやはや、${data.t1n}が大暴れ😲💥首位を飾った${data.t1num}番台は絶好調な挙動をぶん回されてますねぇ👀これはお見事❗️」
→ TOP1・2の機種名・差枚数・特徴に触れて。2〜3文。

【差枚数に応じた表現の基準】※b13で必ず守ること
- 3,500枚以上: 「驚異的」「圧巻」「衝撃的」などの最大級の表現を使う
- 2,500〜3,499枚: 「見事な」「素晴らしい」「圧倒的な」など強めの表現
- 2,000〜2,499枚: 「好調な」「立派な」「堂々たる」など普通に良い表現
- 2,000枚未満: 「堅実な」「安定した」「しっかりした」など落ち着いた表現
差枚数の数値を見て、大げさにも控えめにもならないよう適切な表現を選ぶこと。

■ b9（機種構成の紹介。設置台数テーブルの直後に入る）
今回の設置情報: ${data.machineList}（最多:${data.main}、2番目:${data.second}）
実例:
- 「${data.main}が最多設置、続いて${data.second}といった機種構成になっています📝」
- 「最多設置は${data.main}で、その後を${data.second}が追う形の構成ですね📝」
- 「${data.main}を中心とした設置台数で、${data.second}と合わせてバランス良く揃っています📝」
- 「メインは${data.main}ですっ！続いて${data.second}が並ぶ布陣となっていますよ📝」
- 「設置台数トップは${data.main}、そして${data.second}と続く機種構成です📝」
- 「${data.main}がラインナップの中心を担い、${data.second}と合わさった構成となっていますね📝」
→ 最多機種(${data.main})と2番目(${data.second})を必ず含めて1文。フレンドリーな口調で毎回少し違う表現にすること。

■ b14（締めコメント）
実例:
- 「今回もガッツリと盛り上がっていましたね〜👍同店での戦極〜電光石火〜開催時はかなり期待できそうです！」
- 「ランキングを見る感じ、やはり設置台数が多い機種が多くランクインしている傾向に🤔次回の立ち回りの参考にしてみてくださいね☝️」
- 「やはり多台数設置機種が優勢ではありましたが、全体的にチャンスがあった取材となりましたね☺️」
→ 今回の傾向・次回への期待。1〜2文。

■ b15（レポート終了）
実例:
- 「今回のレポートはここまで✋次回取材もお見逃しなく～」
- 「今回のレポートはここまで✋今後の戦極にも乞うご期待！」
- 「今回のレポートはここまで✋️次回の取材もご期待ください✨️」
→ 短く明るく1文。

【出力形式】
JSONのみを返してください（説明文・コードブロック不要）:
{
  "b3": "...",
  "b5": "...",
  "b6": "...",
  "b9": "...",
  "b13": "...",
  "b14": "...",
  "b15": "..."
}`;

      // この店舗の過去記事があればプロンプトに追加
      const pastArticles = data.pastArticles || [];

      let pastSection = '';
      if (pastArticles.length > 0) {
        const prev = pastArticles[0];
        pastSection = `\n\n【${data.hall}での過去の取材結果（同一店舗のみ）】\n`;
        pastSection += `▼ 前回（${prev.date}）\n`;
        pastSection += `b13: "${prev.texts.b13}"\n`;
        if (prev.top1) pastSection += `前回TOP1機種: ${prev.top1}\n`;
        pastSection += `\n→ b6では上記の前回b13またはTOP1機種名を参考に「前回は○○が優勢でしたが…」の形で書くこと。\n`;

        if (pastArticles.length > 1) {
          pastSection += `\n【文体・語尾の参考（同一店舗の過去生成例）】\n`;
          pastArticles.forEach((p, i) => {
            pastSection += `▼ ${i === 0 ? '前回' : `${i + 1}回前`}（${p.date}）\n`;
            pastSection += `b3: "${p.texts.b3}"\n`;
            pastSection += `b14: "${p.texts.b14}"\n\n`;
          });
        }
        pastSection += '→ 語尾・テンションを参考にしつつ、内容は今回のデータで新たに生成すること。';
      }
      const finalPrompt = prompt + pastSection;

      const reqBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        temperature: 1.0,
        messages: [{ role: 'user', content: finalPrompt }]
      });

      const claudeRes = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(reqBody),
          }
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
            catch(e) { reject(e); }
          });
        });
        r.on('error', reject);
        r.write(reqBody);
        r.end();
      });

      if (claudeRes.status !== 200) {
        console.error('[claude] error:', JSON.stringify(claudeRes.data));
        return sendJson(500, { error: claudeRes.data?.error?.message || 'Claude API エラー' });
      }

      const text = claudeRes.data.content?.[0]?.text || '';
      // JSON部分だけ抽出
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return sendJson(500, { error: '生成結果のパースに失敗しました', raw: text });
      try {
        const parsed2 = JSON.parse(match[0]);
        return sendJson(200, parsed2);
      } catch(e) {
        return sendJson(500, { error: 'JSON解析エラー', raw: text });
      }
    }

    if (req.method === 'POST' && parsed.pathname === '/api/generate-text-ifudodo') {
      const apiKey = config.claude_api_key;
      if (!apiKey) return sendJson(400, { error: 'claude_api_key が設定されていません' });

      const buf = await collectBody(req);
      const data = JSON.parse(buf.toString('utf8'));

      const tones = [
        'テンション高め・感嘆符多め・勢いのある語尾（〜ましたーっ！など）',
        'ユーモアを交えながら親しみやすく・軽快なテンポで',
        'やや落ち着いたトーンだが熱量はしっかり伝わる文体で',
        '興奮気味・驚き表現を前面に出して臨場感たっぷりに',
        '読者に語りかけるような口語調で・絵文字を多めに',
      ];
      const todayTone = tones[Math.floor(Math.random() * tones.length)];

      const prompt = `あなたはパチスロ専門誌「パチ＆スロ必勝本」の取材ライター「新人編集のマモル」です。
サミー系機種取材レポート【戦極～威風堂々～】の詳細コメント（b13）を1つ生成してください。
【今回の文体方針】${todayTone}

【今回の取材情報】
- サミー系機種設置: ${data.machineList}（${data.cnt}機種 合計${data.total}台）
- 差枚RANK1: 【${data.t1n}・${data.t1num}番台】${data.t1d}${data.t1g ? ' / ' + data.t1g : ''}
- 差枚RANK2: 【${data.t2n}・${data.t2num}番台】${data.t2d}${data.t2g ? ' / ' + data.t2g : ''}
- 差枚RANK3: 【${data.t3n}・${data.t3num}番台】${data.t3d}${data.t3g ? ' / ' + data.t3g : ''}
- ランクイン台数トップ: ${data.rankInTop || '不明'}

【文体・トーンのルール】
- テンション高め・フレンドリー・絵文字を適度に使用
- 「〜ですっ」「〜ましたーっ」など語尾に勢いがある
- サミー系機種ならではのゲーム数・枚数への言及を入れること
- 毎回少しずつ違う表現・言い回しにすること

【b13の実例（参考にしてバリエーションを作ること）】
- 「1位の${data.t1n}はなんと${data.t1d}という結果に😲この枚数、この当たり方はさぞ楽しかった事でしょう✨また2位の${data.t2n}も差枚数${data.t2d}とこちらも素晴らしい結果でした‼️」
- 「設置台数の多い機種がほとんどを占めているランキングでしたね🤔特に1位の${data.t1n}は${data.t1d}を記録‼️これは注目せざるを得ませんっ✨」
- 「いやはや、${data.t1n}が大暴れ😲💥首位を飾った${data.t1num}番台は絶好調な挙動でしたねぇ👀これはお見事❗️また2位の${data.t2n}も${data.t2d}とお見事な結果でした‼️」

【差枚数に応じた表現の基準】※必ず守ること
- 10,000枚以上: 「驚異的」「圧巻」「衝撃的」などの最大級の表現を使う
- 6,000〜9,999枚: 「見事な」「素晴らしい」「圧倒的な」など強めの表現
- 3,000〜5,999枚: 「好調な」「立派な」「堂々たる」など普通に良い表現
- 3,000枚未満: 「堅実な」「安定した」「しっかりした」など落ち着いた表現

【出力形式】
JSONのみを返してください（説明文・コードブロック不要）:
{"b13": "..."}`;

      const reqBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        temperature: 1.0,
        messages: [{ role: 'user', content: prompt }]
      });

      const claudeRes = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(reqBody),
          }
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
            catch(e) { reject(e); }
          });
        });
        r.on('error', reject);
        r.write(reqBody);
        r.end();
      });

      if (claudeRes.status !== 200) {
        return sendJson(500, { error: claudeRes.data?.error?.message || 'Claude API エラー' });
      }

      const text = claudeRes.data.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return sendJson(500, { error: '生成結果のパースに失敗しました', raw: text });
      try {
        return sendJson(200, JSON.parse(match[0]));
      } catch(e) {
        return sendJson(500, { error: 'JSON解析エラー', raw: text });
      }
    }

    if (req.method === 'GET' && parsed.pathname === '/api/store-memory') {
      const hall = parsed.searchParams.get('hall') || '';
      const memory = readStoreMemory();
      const past = (memory[hall] || []).slice(0, 3);
      const prevTop1 = past.length > 0 ? (past[0].top1 || '') : '';
      return sendJson(200, { past, prevTop1 });
    }

    if (req.method === 'POST' && parsed.pathname === '/api/store-memory') {
      const buf = await collectBody(req);
      const { hall, date, texts, top1 } = JSON.parse(buf.toString('utf8'));
      const memory = readStoreMemory();
      if (!memory[hall]) memory[hall] = [];
      memory[hall].unshift({ date, texts, top1: top1 || '' });
      if (memory[hall].length > 3) memory[hall] = memory[hall].slice(0, 3);
      writeStoreMemory(memory);
      return sendJson(200, { ok: true });
    }

    res.writeHead(404);
    res.end('Not found');

  } catch (err) {
    console.error(err);
    sendJson(500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`WordPress投稿ツール起動中 → http://localhost:${PORT} をブラウザで開いてください`);
});
