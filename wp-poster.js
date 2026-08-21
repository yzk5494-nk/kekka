const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = require('puppeteer-core'); }
const { convertImagesTree, persistImageValue, LIB_IMAGES_DIR } = require('./lib-image-store');
const hallAnalyticsDb = require('./hall-analytics-db');

// 設定読み込み
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'wp-config.json'), 'utf8'));
const WP_URL = config.url;
const AUTH = Buffer.from(`${config.username}:${config.password}`).toString('base64');

// Railwayの永続ボリュームがマウントされていればそちらにデータを保存する（デプロイをまたいでも消えないように）
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
// ボリューム初回起動時、Gitにコミットされている既存データをシードとしてコピーしておく
function seedIfMissing(relPath) {
  if (DATA_DIR === __dirname) return;
  const dest = path.join(DATA_DIR, relPath);
  const src = path.join(__dirname, relPath);
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
['x-library.json', 'store-memory.json', 'article-data/library.json', 'pickup-data/library.json'].forEach(seedIfMissing);

// 起動時: ライブラリ画像がまだbase64埋め込みのままなら個別ファイルに変換しておく
// （初回デプロイ時点の永続ボリューム上の既存データを1回だけ軽量化するため。変換済みなら何もしない）
function migrateLibraryImagesOnBoot(relFile, subdir, nested) {
  try {
    const full = path.join(DATA_DIR, relFile);
    if (!fs.existsSync(full)) return;
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    const stats = convertImagesTree(data.images, subdir, nested);
    if (stats.converted > 0) {
      fs.writeFileSync(full, JSON.stringify(data), 'utf8');
      console.log(`[起動時移行] ${relFile}: ${stats.converted}枚をlibrary-imagesに変換しました`);
    }
  } catch (e) {
    console.error(`[起動時移行] ${relFile} の変換に失敗:`, e.message);
  }
}
migrateLibraryImagesOnBoot('article-data/library.json', 'article', true);
migrateLibraryImagesOnBoot('pickup-data/library.json', 'pickup', false);

// Xポストライブラリ
const X_LIBRARY_FILE = path.join(DATA_DIR, 'x-library.json');
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
const STORE_MEMORY_FILE = path.join(DATA_DIR, 'store-memory.json');
function readStoreMemory() {
  try { return JSON.parse(fs.readFileSync(STORE_MEMORY_FILE, 'utf8')); } catch { return {}; }
}
function writeStoreMemory(data) {
  fs.writeFileSync(STORE_MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// hisshobon-hall.info 設定
const HB = config.hisshobon;
const HB_AUTH = Buffer.from(`${HB.username}:${HB.password}`).toString('base64');

// hisshobonカテゴリー・タグのキャッシュ（毎回WPへ取りに行かず、手動更新ボタンで再取得するまで使い回す）
const HB_CACHE_FILE = path.join(DATA_DIR, 'hb-cache.json');
function readHbCache() {
  try { return JSON.parse(fs.readFileSync(HB_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeHbCache(data) {
  fs.writeFileSync(HB_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

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

// hisshobon-hall.info の全ページを取得（1ページ目で総ページ数を確認後、残りを並列取得）
async function hbFetchAllPages(endpoint) {
  const first = await hbRequest('GET', `${endpoint}?per_page=100&page=1`);
  const totalPages = parseInt(first.headers?.['x-wp-totalpages'] || '1', 10);
  let all = Array.isArray(first.data) ? first.data : [];
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => hbRequest('GET', `${endpoint}?per_page=100&page=${i + 2}`))
    );
    rest.forEach(r => { if (Array.isArray(r.data)) all = all.concat(r.data); });
  }
  return all;
}

// カテゴリー・タグはキャッシュ（hb-cache.json）があればそれを返し、無ければWPから取得して保存する
async function getHbCategories() {
  const cache = readHbCache();
  if (Array.isArray(cache.categories)) return cache.categories;
  const all = await hbFetchAllPages('categories');
  writeHbCache({ ...readHbCache(), categories: all });
  return all;
}
async function getHbTags() {
  const cache = readHbCache();
  if (Array.isArray(cache.tags)) return cache.tags;
  const all = await hbFetchAllPages('tags');
  writeHbCache({ ...readHbCache(), tags: all });
  return all;
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

// PISION（P-PRO）API リクエスト
function pisionRequest(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const pision = config.pision || {};
    const urlObj = new URL(pision.base_url + pathAndQuery);
    const headers = { [pision.api_key_header || 'X-Api-Key']: pision.api_key };
    const req = https.request(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`PISION API エラー(${res.statusCode}): ${raw.slice(0, 200)}`));
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
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

// AIが生成したJSON文字列内に、文字列値としてエスケープされていない生の改行等の
// 制御文字が混ざっていると JSON.parse が失敗するため、文字列リテラル内でのみ
// 制御文字をエスケープしてから返す
function sanitizeAiJsonText(raw) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; }
    out += ch;
  }
  return out;
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
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

  // クロスオリジンでのJSON POST（yg-poster.htmlからRailway本番への直接送信等）は、
  // ブラウザがまずOPTIONSでプリフライト確認を行う。これに応答しないとブロックされる
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

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

    if (req.method === 'GET' && parsed.pathname === '/hall-analytics') {
      const html = fs.readFileSync(path.join(__dirname, 'hall-analytics.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && parsed.pathname === '/article-generator') {
      const html = fs.readFileSync(path.join(__dirname, 'article-generator.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && parsed.pathname === '/post-creator') {
      const html = fs.readFileSync(path.join(__dirname, 'post-creator.html'), 'utf8');
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

    // ── 画像プロキシ（外部画像をCanvasに描画してもCORSで汚染されないように同一オリジン経由で配信）──
    if (req.method === 'GET' && parsed.pathname === '/api/proxy-image') {
      const target = parsed.query.url;
      if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('Bad url'); }
      https.get(target, upstream => {
        res.writeHead(upstream.statusCode, { 'Content-Type': upstream.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        upstream.pipe(res);
      }).on('error', () => { res.writeHead(502); res.end('Proxy error'); });
      return;
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

    // ── 静的アセット配信（グラフ背景画像・フォント等） ──────────────────
    if (req.method === 'GET' && parsed.pathname.startsWith('/assets/')) {
      const filename = path.basename(parsed.pathname);
      const filePath = path.join(__dirname, 'assets', filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        const mime = { '.png':'image/png', '.jpg':'image/jpeg', '.ttf':'font/ttf' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(fs.readFileSync(filePath));
      }
      res.writeHead(404); return res.end('Not found');
    }

    // ── ライブラリ画像静的配信（article/pickup 配下の個別画像ファイル） ──────
    if (req.method === 'GET' && parsed.pathname.startsWith('/library-images/')) {
      const relPath = decodeURIComponent(parsed.pathname.replace('/library-images/', ''));
      if (relPath.includes('..')) { res.writeHead(400); return res.end('Bad request'); }
      const filePath = path.join(LIB_IMAGES_DIR, relPath);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' }[ext] || 'application/octet-stream';
        // yg-poster.html（localhost含む）からfetchでこの画像を取得しbase64化する処理があるため、CORSを許可する
        res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
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
      const filePath = path.join(__dirname, '店内差玉数ランキング.jpg');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
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
      const libPath = path.join(DATA_DIR, 'article-data', 'library.json');
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
      const libPath = path.join(DATA_DIR, 'article-data', 'library.json');
      const data = JSON.parse(buf.toString('utf8'));
      // 新しく登録された画像（base64埋め込み）はファイルに保存し、JSONには参照だけ残す
      convertImagesTree(data.images, 'article', true);
      fs.mkdirSync(path.dirname(libPath), { recursive: true });
      fs.writeFileSync(libPath, JSON.stringify(data), 'utf8');
      return sendJson(200, { ok: true });
    }

    // ── 優秀台ピックアップ用ライブラリ（pickup-data/library.json）──
    if (req.method === 'GET' && parsed.pathname === '/api/pickup-library') {
      const libPath = path.join(DATA_DIR, 'pickup-data', 'library.json');
      if (fs.existsSync(libPath)) {
        const data = fs.readFileSync(libPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(data);
      } else {
        return sendJson(200, { images: {}, nicknames: {} });
      }
    }
    if (req.method === 'POST' && parsed.pathname === '/api/pickup-library') {
      const buf = await collectBody(req);
      const libPath = path.join(DATA_DIR, 'pickup-data', 'library.json');
      const data = JSON.parse(buf.toString('utf8'));
      // 新しく登録された画像（base64埋め込み）はファイルに保存し、JSONには参照だけ残す
      convertImagesTree(data.images, 'pickup', false);
      fs.mkdirSync(path.dirname(libPath), { recursive: true });
      fs.writeFileSync(libPath, JSON.stringify(data), 'utf8');
      return sendJson(200, { ok: true });
    }

    // ── yg-poster.html：イベント画像ライブラリ（旧localStorage yg_event_lib から移行） ──
    if (req.method === 'GET' && parsed.pathname === '/api/event-library') {
      const libPath = path.join(DATA_DIR, 'event-data', 'library.json');
      if (fs.existsSync(libPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(fs.readFileSync(libPath, 'utf8'));
      }
      return sendJson(200, {});
    }
    if (req.method === 'POST' && parsed.pathname === '/api/event-library') {
      const buf = await collectBody(req);
      const data = JSON.parse(buf.toString('utf8'));
      for (const name of Object.keys(data)) {
        const entry = data[name];
        if (entry && typeof entry === 'object') {
          if (entry.image) entry.image = persistImageValue('event', entry.image);
          if (entry.ruleImage) entry.ruleImage = persistImageValue('event', entry.ruleImage);
        }
      }
      const libPath = path.join(DATA_DIR, 'event-data', 'library.json');
      fs.mkdirSync(path.dirname(libPath), { recursive: true });
      fs.writeFileSync(libPath, JSON.stringify(data), 'utf8');
      return sendJson(200, { ok: true });
    }

    // ── yg-poster.html：アイキャッチ画像ライブラリ（旧localStorage yg_featured_lib から移行） ──
    if (req.method === 'GET' && parsed.pathname === '/api/featured-library') {
      const libPath = path.join(DATA_DIR, 'featured-data', 'library.json');
      if (fs.existsSync(libPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(fs.readFileSync(libPath, 'utf8'));
      }
      return sendJson(200, []);
    }
    if (req.method === 'POST' && parsed.pathname === '/api/featured-library') {
      const buf = await collectBody(req);
      const data = JSON.parse(buf.toString('utf8'));
      for (const item of data) {
        if (item && typeof item === 'object' && item.data) item.data = persistImageValue('featured', item.data);
      }
      const libPath = path.join(DATA_DIR, 'featured-data', 'library.json');
      fs.mkdirSync(path.dirname(libPath), { recursive: true });
      fs.writeFileSync(libPath, JSON.stringify(data), 'utf8');
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
      const { name, parent, slug } = JSON.parse(buf.toString('utf8'));
      if (!name || !name.trim()) return sendJson(400, { error: 'カテゴリー名を入力してください' });
      const payload = { name: name.trim(), parent: parent || 0 };
      if (slug && slug.trim()) payload.slug = slug.trim();
      const r = await ygRequest('POST', 'categories', payload);
      console.log(`[yg-category] status=${r.status} name="${name}" parent=${parent || 0} slug="${slug || ''}"`);
      return sendJson(r.status, r.data);
    }

    // ── YG カテゴリー スラッグ修正 ──────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/update-yg-category-slug') {
      const buf = await collectBody(req);
      const { id, slug } = JSON.parse(buf.toString('utf8'));
      if (!id) return sendJson(400, { error: 'カテゴリーIDが必要です' });
      if (!slug || !slug.trim()) return sendJson(400, { error: 'スラッグを入力してください' });
      const r = await ygRequest('POST', `categories/${id}`, { slug: slug.trim() });
      console.log(`[yg-category-slug] status=${r.status} id=${id} slug="${slug}"`);
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
    // yg-blog.comへの投稿。ホール分析データはここでは保存しない（yg-poster.html側からRailway本番の
    // /api/hall-analytics/import へ直接送る設計。yg-blog.com自体がXSERVER側の制限でRailwayからの
    // 書き込みを拒否するため、投稿はローカル端末から行い、分析データだけ本番に一元化するための構成）
    if (req.method === 'POST' && parsed.pathname === '/api/create-yg-post') {
      const buf = await collectBody(req);
      const postData = JSON.parse(buf.toString('utf8'));
      const r = await ygRequest('POST', 'posts', postData);
      console.log(`[yg-post] status=${r.status} title="${postData.title}"`);
      return sendJson(r.status, r.data);
    }

    // ── ホール分析：店舗一覧 ──────────────────────────────────────
    // （CORSは共通のsendJsonヘルパーが Access-Control-Allow-Origin: * を付与済みなので、
    //   yg-blog.com上の埋め込みウィジェットから直接fetchできる。個別設定は不要）
    if (req.method === 'GET' && parsed.pathname === '/api/hall-analytics/stores') {
      return sendJson(200, { stores: hallAnalyticsDb.listStores() });
    }

    // ── ホール分析：店舗の取材名一覧 ────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hall-analytics/coverage-names') {
      const storeName = parsed.searchParams.get('store');
      if (!storeName) return sendJson(400, { error: 'store（店舗名）が必要です' });
      return sendJson(200, { coverageNames: hallAnalyticsDb.listCoverageNames(storeName) });
    }

    // ── ホール分析：店舗×取材名の詳細集計 ─────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hall-analytics/detail') {
      const storeName = parsed.searchParams.get('store');
      const coverageName = parsed.searchParams.get('coverage');
      if (!storeName || !coverageName) return sendJson(400, { error: 'store・coverageが必要です' });
      const detail = hallAnalyticsDb.getDetail(storeName, coverageName);
      if (!detail) return sendJson(400, { error: '該当するデータが見つかりません' });
      return sendJson(200, detail);
    }

    // ── ホール分析：直接インポート（WP投稿を経由せず、別環境で記録したデータを移すための手動用） ──
    if (req.method === 'POST' && parsed.pathname === '/api/hall-analytics/import') {
      const buf = await collectBody(req);
      const body = JSON.parse(buf.toString('utf8'));
      try {
        hallAnalyticsDb.upsertArticleAndGroups(body);
        return sendJson(200, { ok: true });
      } catch (e) {
        return sendJson(500, { error: e.message });
      }
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

    // ── p-world 設置台数合計（パチンコ／スロット・遊技料金）スクレイピング ──
    if (req.method === 'POST' && parsed.pathname === '/api/scrape-pworld-total') {
      const buf = await collectBody(req);
      const { pageUrl } = JSON.parse(buf.toString('utf8'));
      if (!pageUrl || !pageUrl.includes('p-world.co.jp')) {
        return sendJson(400, { error: 'p-worldのURLを入力してください' });
      }

      let browser;
      try {
        const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
        if (process.platform === 'win32') launchOpts.executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        const info = await page.evaluate(() => {
          const findValueCell = (label) => {
            const td = [...document.querySelectorAll('td')].find(t => t.textContent.trim().replace(/\s|　/g, '') === label);
            return td ? td.nextElementSibling : null;
          };

          let pachinkoTotal = null, slotTotal = null;
          const taisuCell = findValueCell('台数');
          if (taisuCell) {
            const text = taisuCell.textContent;
            const mP = text.match(/パチンコ\s*([0-9,]+)\s*台/);
            const mS = text.match(/スロット\s*([0-9,]+)\s*台/);
            if (mP) pachinkoTotal = parseInt(mP[1].replace(/,/g, ''), 10);
            if (mS) slotTotal = parseInt(mS[1].replace(/,/g, ''), 10);
          }

          let denominations = [];
          const feeCell = findValueCell('遊技料金');
          if (feeCell) {
            const text = feeCell.textContent;
            const pMatch = text.match(/パチンコ[：:]?\s*((?:\[[^\]]+\]\s*)+)/);
            if (pMatch) {
              const nums = [...pMatch[1].matchAll(/1000円\/([0-9,]+)玉/g)].map(m => parseInt(m[1].replace(/,/g, ''), 10));
              const candidates = [4, 2.5, 1];
              denominations = [...new Set(nums.map(n => {
                const rate = 1000 / n;
                return candidates.reduce((a, b) => Math.abs(b - rate) < Math.abs(a - rate) ? b : a);
              }))].sort((a, b) => b - a).map(r => `${r}円`);
            }
          }

          return { pachinkoTotal, slotTotal, denominations };
        });

        console.log('[pworld-total] 取得結果:', info);
        return sendJson(200, info);
      } catch(e) {
        console.error('[pworld-total] error:', e.message);
        return sendJson(500, { error: e.message });
      } finally {
        if (browser) await browser.close();
      }
    }

    // ── p-town(DMM) スクレイピング ────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/scrape-ptown') {
      const buf = await collectBody(req);
      const { pageUrl, keywords } = JSON.parse(buf.toString('utf8'));
      if (!pageUrl) return sendJson(400, { error: 'pageUrl が必要です' });
      const filterKeywords = (keywords && keywords.length) ? keywords : null;

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
        const { machines, debugCategories } = await page.evaluate((filterKeywords) => {
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
            // シリーズの機種フィルターが指定されていればそれで判定、
            // なければ従来通りジャグラー機種のみを対象にする
            if (filterKeywords && filterKeywords.length) {
              if (!filterKeywords.some(kw => name?.includes(kw))) return;
            } else {
              if (!name?.includes('ジャグ')) return;
            }

            // この除外カテゴリー判定は全シリーズ共通
            const category = machineCategory.get(a) || '';
            if (category.includes('178') || category.includes('160') || category.includes('188') || category.includes('184') || category.includes('2.5') || category.includes('２.５') || category.includes('5.495') || category.includes('５.４９５') || category.includes('[5]') || category.includes('[５]')) return;

            const li = a.closest('li');
            const liText = li?.innerText || '';
            const countMatch = liText.replace(name, '').match(/(\d+)/);
            const count = countMatch ? parseInt(countMatch[1]) : 0;
            if (count > 0) results.push({ name, count });
          });
          return { machines: results, debugCategories };
        }, filterKeywords);

        console.log(`[ptown] 取得: ${machines.length}機種, カテゴリー: ${debugCategories.join(', ')}`);
        return sendJson(200, { machines, debugCategories });
      } catch(e) {
        console.error('[ptown] error:', e.message);
        return sendJson(500, { error: e.message });
      } finally {
        if (browser) await browser.close();
      }
    }

    // ── hisshobon カテゴリー一覧（全件・キャッシュ優先） ───────────
    if (req.method === 'GET' && parsed.pathname === '/api/hb-categories') {
      const all = await getHbCategories();
      return sendJson(200, all);
    }

    // ── hisshobonカテゴリー・タグキャッシュの手動更新 ───────────────
    if (req.method === 'POST' && parsed.pathname === '/api/hb-cache-refresh') {
      const [categories, tags] = await Promise.all([hbFetchAllPages('categories'), hbFetchAllPages('tags')]);
      writeHbCache({ categories, tags });
      return sendJson(200, { categories: categories.length, tags: tags.length });
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
      const all = await hbFetchAllPages('categories');
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

    // ── hisshobon 店舗情報ブロック（blog_parts）一覧 ──────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hb-blog-parts') {
      const all = await hbFetchAllPages('blog_parts');
      return sendJson(200, all);
    }

    // ── hisshobon タグ一覧（全件・キャッシュ優先） ──────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/hb-tags') {
      const all = await getHbTags();
      return sendJson(200, all);
    }

    // ── hisshobon レポート投稿 ──────────────────────────────────
    if (req.method === 'POST' && parsed.pathname === '/api/create-hb-post') {
      const buf = await collectBody(req);
      const { title, content, status, categories, tags, featured_media, date } = JSON.parse(buf.toString('utf8'));
      const body = { title, content, status: status || 'draft' };
      if (categories && categories.length) body.categories = categories;
      if (tags && tags.length) body.tags = tags;
      if (featured_media) body.featured_media = featured_media;
      if (date) body.date = date;
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
      const apiKey = process.env.CLAUDE_API_KEY || config.claude_api_key;
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
      const eventName = data.eventName || '戦極～電光石火～';
      const series = data.series || '';
      const adjMul = data.adjMultiplier || 1;
      const bodyUnit = data.bodyUnit || '枚';
      const pastArticles = data.pastArticles || [];
      const prevArticle = pastArticles[0];

      const b3Section = series === 'tokyoghoul' ? `■ b3（新企画の紹介。2026年開始・2025年に話題になった機種への特化調査という体で）
実例:
- 「さぁ、2026年から始まった新企画【${eventName}】👿👿👿\nこの取材は2025年で最も話題を集め、プレイヤーの心を鷲掴みにしたスマスロ東京喰種に特化した徹底調査でありますっ💪」
- 「2026年よりスタートした新企画【${eventName}】👿\n2025年、プレイヤーを熱狂させたスマスロ東京喰種のみに焦点を当てた徹底調査を行って参りましたっ💪」
- 「満を持して2026年に始動した新企画【${eventName}】👿👿\n2025年最も話題をさらったスマスロ東京喰種、その実態を徹底的に調査してきましたっ💪」
- 「2026年、新たに動き出した企画【${eventName}】👿\n2025年に絶大な人気を博したスマスロ東京喰種だけを追いかける徹底調査ですっ💪」
→ 「2026年から始まった新企画」であること、「2025年に最も話題になった／プレイヤーの心を鷲掴みにした」という点、「スマスロ東京喰種に特化した徹底調査」という要素は必ず含め、言い回しだけを変えること。2文。` : series === 'shishifunjin' ? `■ b3（好評開催中＋SANKYO機種特化調査という体で）
実例:
- 「好評を博し、2026年も絶賛開催中となっている【${eventName}】🌸🌸🌸\nこの取材は、今のパチスロシーンを代表する"SANKYO機種"に特化した編集部総力調査です🌸🌸🌸」
→ 「好評を博し、2026年も絶賛開催中」であること、「今のパチスロシーンを代表するSANKYO機種に特化した編集部総力調査」という要素は必ず含め、言い回しだけを変えること。2文。` : series === 'hyakkaryoran' ? `■ b3（取材対象をハナ系機種に絞った総力調査という体で）
実例:
- 「【${eventName}】は取材対象をハナ系に絞った総力調査取材！」
→ 「取材対象をハナ系機種に絞った総力調査（取材）」という要素は必ず含め、言い回しだけを変えること。1文。` : series === 'ikkyunyukon' ? `■ b3（多くの要望を受けてスタートした企画という背景の紹介）
実例:
- 「多くのご要望を頂きスタートした戦極系最新取材の【${eventName}】🔮」
- 「読者の熱いリクエストに応える形で始動した戦極系新企画【${eventName}】🎱」
- 「たくさんの声にお応えしてスタートした戦極系最新取材の【${eventName}】🔮」
- 「多くの反響を受けてついに始動した戦極系新企画【${eventName}】🎱」
→ 「多くのご要望・リクエストを受けてスタートした企画」であることは必ず含め、言い回しだけを変えること。絵文字は🎱や🔮など玉を連想させるものを使い、🤡は使わないこと。1文。` : series === 'tenchishinmei' ? `■ b3（今夏スタートした新企画の紹介）
実例:
- 「戦極シリーズより新たな取材がこの夏スタート🌞\nその名も【${eventName}】⚡」
- 「この夏より新たにスタートした【${eventName}】⚡🌞」
- 「戦極シリーズに新たな取材企画がこの夏加わりました🌞\nその名も【${eventName}】⚡」
- 「今年の夏から新しく幕を開けた戦極系最新企画【${eventName}】⚡🌞」
→ 「戦極シリーズの新企画」であること、「この夏（今年の夏）からスタートした」という要素は必ず含め、言い回しだけを変えること。絵文字は⚡や🌞など夏・スタートを連想させるものを使うこと。1〜2文。` : series === 'tenkamusou' ? (data.firstTime ? `■ b3（初開催の紹介）
実例:
- 「コチラのお店では初開催となる【${eventName}】の取材📷✨\n${data.city}の地でどんな景色を見せてくれるのかたのしみですね～😊」
- 「こちらの店舗にて初開催‼️\n【${eventName}】取材、一体どんな結果が待っているのでしょうか😆」
→ 「初開催」であることに触れ、期待感を出すこと。地名（${data.city}）以外の、その土地の具体的な特徴（駅前・大型店舗の有無など実在するか分からない情報）には触れないこと。2文。` : `■ b3（お馴染みの取材という紹介）
実例:
- 「こちらの店舗では恒例の【${eventName}】取材‼️\n前回も素晴らしい景色を見せていただいたので今回も期待ですね😁」
- 「${data.city}の優良店舗であるコチラのお店🎉🎉🎉\nコチラのお店ではお馴染みとなった【${eventName}】取材📷✨」
→ 「恒例」「お馴染み」など複数回目であることが伝わる表現を使い、前回の結果への期待感を出すこと。地名（${data.city}）以外の、その土地の具体的な特徴には触れないこと。2文。`) : `■ b3（${eventName}の形容。慣用句＋イベント名の形）
実例:
- 「回を重ねるに連れて好評を博している${eventName}🤡」
- 「破竹の勢いで規模を拡大している${eventName}」
- 「一気呵成の勢いで規模を拡大している${eventName}🤡」
- 「飛ぶ鳥を落とす勢いで規模を拡大している${eventName}」
- 「回を増す毎に好評を博している${eventName}🤡」
- 「破竹の勢いで広がり続けている${eventName}」
→ 慣用句・比喩表現を変えて1文で。`;

      let b5Section;
      if (series === 'tokyoghoul') {
        const openCount = data.openCount || (pastArticles.length + 1); // openCountは通算回数（store-memoryに記録）。無ければ保存上限3件からの概算にフォールバック
        let prevMonth = '';
        if (prevArticle?.date) {
          const m = prevArticle.date.split('/')[1];
          if (m) prevMonth = `${parseInt(m, 10)}月`;
        }
        b5Section = data.firstTime ? `■ b5（初開催の告知）
実例:
- 「こちらの店舗での${eventName}開催は今回が初‼️どんな結果が待っているのか楽しみですっ🔥」
- 「同店では今回が${eventName}の初開催となります‼️果たしてどんな盛り上がりを見せてくれるのか🔥」
→ 「初開催」であることに触れ、期待感を出す。1文。` : `■ b5（開催回数＋前回の盛り上がりアピール）
今回の情報: 開催は${openCount}回目${prevMonth ? `、前回取材は${prevMonth}` : ''}
${prevArticle?.texts?.b13 ? `前回のB13参考: "${prevArticle.texts.b13}"` : ''}
実例:
- 「こちらの店舗での${eventName}開催は2回目‼️\n前回は4月に取材を行い、万枚オーバー台が複数現れるほどに盛り上がりましたので、今回の結果も楽しみにしています🔥🔥」
→ 前半で「開催は${openCount}回目」であることに触れ、後半で前回${prevMonth ? `(${prevMonth})` : ''}の取材結果(上記B13参考があればそれを踏まえる)を出玉的にアピールすること。前回情報が無ければ後半は省略可。1〜2文。`;
      } else if (series === 'shishifunjin') {
        b5Section = `■ b5（全国参戦告知＋どのホールが制するか気になる煽り）
実例:
- 「今月も全国津々浦々、出玉自慢のホールが参戦⚔⚔⚔\n荒波マシンを制するホールは果たしてどのホールになるのでしょうか…⁉️」
→ 「全国津々浦々、出玉自慢のホールが参戦」であること、「荒波マシンを制するホールはどこか」という問いかけの要素は必ず含め、言い回しだけを変えること。2文。`;
      } else if (series === 'ikkyunyukon') {
        b5Section = `■ b5（全国参戦告知）
実例:
- 「${month}も全国で名を馳せるパチンコ自慢ホールが参戦‼️各地で熱い戦いを繰り広げて参りますっ⚔️」
- 「${month}も全国のパチンコ自慢ホールが多数参戦‼️各地で熱戦を繰り広げていますっ⚔️」
- 「${month}も全国で評判のパチンコ自慢ホールが参戦‼️各地で白熱の戦いを繰り広げて参りますっ⚔️」
- 「${month}もパチンコファンの育成に注力するホールが参戦っ‼️」
- 「${month}もパチンコの魅力を発信し続けるホールが参戦っ‼️」
- 「${month}もパチンコファンから支持を集めるホールが参戦っ‼️」
- 「${month}もパチンコの奥深さを追求するホールが参戦っ‼️」
- 「${month}もパチンコ愛溢れるホールが参戦っ‼️各地で熱い戦いを繰り広げて参りますっ⚔️」
- 「${month}もパチンコという名のフィールドに特化した熱戦が繰り広げられますっ⚔️⚔️⚔️」
→ 店舗数（◯店舗などの具体的な数字）には一切触れず、月・言い回しだけを変えること。1文。`;
      } else if (series === 'ifudodo') {
        b5Section = `■ b5（全国参戦告知）
実例:
- 「${month}も全国各地で${eventName}参戦ホールが集結‼️各地で熱戦を繰り広げていますっ⚔️」
- 「${month}も全国各地から${eventName}参戦ホールが集まっています‼️各地で熱い戦いを繰り広げていますよ⚔️」
- 「${month}も全国の${eventName}参戦ホールが熱戦を繰り広げていますっ⚔️」
- 「${month}も全国各地で${eventName}に挑むホールが集結‼️各地で熱戦が繰り広げられていますっ⚔️」
→ 店舗数（◯店舗などの具体的な数字）には一切触れず、月・言い回しだけを変えること。1文。`;
      } else if (series === 'tenchishinmei') {
        b5Section = `■ b5（新規参戦ホールが続々というアピール。今夏スタートしたばかりで参戦店舗数がまだ多くないため、店舗数の具体的な数字には絶対に触れないこと）
実例:
- 「${month}も新たな参戦ホールが続々登場中‼️各地で熱い戦いの幕が上がっていますっ⚔️」
- 「${month}も全国各地から新規参戦ホールが続々‼️続々と熱戦の輪が広がっていますよ⚔️」
- 「${month}も新たに${eventName}へ挑むホールが続々登場‼️各地で熱戦が繰り広げられていますっ⚔️」
→ 店舗数（◯店舗、約◯店舗などの具体的・概算の数字）には一切触れず、「新規参戦ホールが続々」という新シリーズならではの勢いを表現すること。月・言い回しだけを変えること。1文。`;
      } else if (series === 'tenkamusou') {
        b5Section = `■ b5（朝イチの並びチェックへの導入）
実例:
- 「まずは朝イチの並びをチェックいたしましょう📝」
- 「それでは、まず朝イチの並びをチェックいたしましょう📷」
- 「まずは朝イチの並びをご覧くださいっ👀」
→ 「朝イチの並びをチェック（確認）する」という導入であることは必ず含め、言い回しだけを変えること。店舗数など他の情報には触れないこと。1文。`;
      } else {
        b5Section = `■ b5（全国参戦告知）
実例:
- 「今月も全国で名を馳せる${eventName}参戦ホールの40店舗以上が参戦‼️各地で熱戦を繰り広げていますっっ⚔️」
- 「${month}も全国津々浦々の有名ホール・約50店舗が集結っ‼️各地で熱い戦いを繰り広げていますよ⚔️⚔️⚔️」
- 「今月も全国で名を馳せる${eventName}自慢ホールが約50店舗も参戦‼️各地で熱戦を繰り広げて参りますっ⚔️」
→ 店舗数（40〜50店舗）・月・表現を少し変えて。1〜2文。`;
      }

      // 東京喰種はb5で開催回数を扱うためb6は生成しない（空文字を返す）
      let b6Section;
      if (series === 'tokyoghoul') {
        b6Section = '';
      } else if (series === 'tenchishinmei') {
        const openCount = data.openCount || (pastArticles.length + 1);
        let prevMonth = '';
        if (prevArticle?.date) {
          const m = prevArticle.date.split('/')[1];
          if (m) prevMonth = `${parseInt(m, 10)}月`;
        }
        b6Section = data.firstTime ? `■ b6（往年の名機ミリオンゴッドに特化した取材である旨＋新シリーズへの意気込み＋初開催の告知）
実例:
- 「この取材は往年の名機ミリオンゴッドに特化した徹底取材となります✍新シリーズということで私もいつも以上に気合いが入っておりますっ💪\nそしてこちらの店舗での${eventName}開催は今回が初‼️どんな結果が待っているのか楽しみですっ🔥」
- 「往年の名機ミリオンゴッドに特化した徹底取材、新シリーズということでいつも以上に気合いが入っておりますっ💪\n同店では今回が${eventName}の初開催となります‼️果たしてどんな盛り上がりを見せてくれるのか🔥」
- 「今回は往年の名機ミリオンゴッドのみに焦点を当てた徹底調査を行って参りましたっ✍新シリーズだけに気合いも十分ですっ💪\n記念すべき同店での初開催、どんな結果が待っているのでしょうか⁉️」
→ 「往年の名機ミリオンゴッドに特化した徹底取材」であること、「新シリーズならではの気合い・意気込み」、「同店では今回が初開催」であることを必ず含め、言い回しだけを変えること。絵文字は✍・💪などを使うこと。2文。` : `■ b6（往年の名機ミリオンゴッドに特化した取材である旨＋開催回数のアピール。単一機種のため前回の機種名比較はしないこと）
今回の情報: 開催は${openCount}回目${prevMonth ? `、前回取材は${prevMonth}` : ''}
実例:
- 「この取材は往年の名機ミリオンゴッドに特化した徹底取材となります✍\nこちらの店舗での${eventName}開催は2回目‼️前回に引き続き、今回も気合いを入れて取材して参りましたっ💪」
- 「往年の名機ミリオンゴッドに特化した徹底取材、新シリーズということでいつも以上に気合いが入っておりますっ💪\nこちらの店舗での${eventName}開催も今回で${openCount}回目となりますっ✨」
- 「今回も往年の名機ミリオンゴッドのみに焦点を当てた徹底調査を行って参りましたっ✍\n同店での${eventName}開催は${openCount}回目、引き続き気合い十分でお届けしますっ💪」
→ 「往年の名機ミリオンゴッドに特化した徹底取材」であることに触れつつ、「開催は${openCount}回目」であることを必ず含めること。機種名の比較（前回は◯◯が優勢等）はしないこと。絵文字は✍・💪などを使うこと。2文。`;
      } else if (series === 'tenkamusou') {
        b6Section = `■ b6（並び人数ブロックの直後に入る。総入場数へのお礼コメント）
${data.lineupTotal ? `今回の情報: この日の総入場数は${data.lineupTotal}名` : ''}
実例:
- 「この日の総入場数は237名様❗️\n朝からお集まり頂いた皆さん、ありがとうございましたーっ🙏」
- 「ということで、この日の入場は約100名様✨\n朝からお越し下さった皆さん、ありがとうございます🙇‍♀️」
- 「今回は朝から約170名様にお集まりいただきましたーっ❗️\n皆さん、ありがとうございます🙏」
→ ${data.lineupTotal ? `総入場数（${data.lineupTotal}名）に必ず触れ、` : ''}朝から来店してくれた方への感謝を伝えること。前回の振り返りや機種名には触れないこと。2文。`;
      } else if (data.firstTime) {
        b6Section = `■ b6（初開催）
実例:
- 「いよいよ同店に${eventName}が初上陸🎉どの機種から優秀台が飛び出すのか、期待MAXで参戦してきましたーっ✨」
- 「記念すべき初開催となった同店での${eventName}⚔️どんな結果が待っているのでしょうか⁉️」
- 「満を持して${eventName}が初登場🔥さあ、同店の設置機種はどこまでやってくれるのか！目が離せませんっ✨」
- 「ついに初陣を迎えた同店での${eventName}🎊前評判通りの盛り上がりが見られるのか、ドキドキしながら参戦してきましたよっ✨」
- 「同店では今回が初の${eventName}開催‼️どの機種がこの記念すべき第1回の主役に輝くのか、楽しみで仕方ありませんっ🔥」
→ 「初上陸」「初開催」「初登場」「初陣」など"初めて"の表現を使い、期待感を前面に出した1〜2文にすること。前回機種には触れない。`;
      } else {
        b6Section = `■ b6（前回振り返り＆今回への期待）
実例:
- 「前回は${data.prev}が優勢でしたが、果たしてどの機種から優秀台が現れるのでしょうか⁉️」
- 「コチラの店舗ではお馴染みとなった${eventName}🎉前回は${data.prev}に絶好調な挙動を示す台が見つかり盛り上がりましたが、今回はどうなるか！」
- 「前回は${data.prev}を筆頭に盛り上がっていましたが、今回はどの機種が1位となるのか楽しみですね✨️」
- 「前回に引き続き${data.prev}が連覇を飾るのか、それとも他機種の刺客が現れるのか⁉️ドキドキが止まりませんっ✨」
- 「${data.prev}が輝いた前回から一転、今回はどんなドラマが待ち受けているのでしょうか🎯目が離せませんね‼️」
- 「前回は${data.prev}がランキングを席巻していましたが、今回もその覇権が続くのか、それとも新星が誕生するのか⁉️」
- 「前回取材では${data.prev}が大活躍でしたが、今回はどの機種が頂点に立つのか、期待が膨らみますねっ🎊」
- 「前回は${data.prev}が存在感を放っていましたね🤔果たして今回もその勢いは続くのか、それとも大逆転劇が待っているのか⁉️」
- 「前回の${data.prev}旋風からどう変わるのか⁉️今回のランキングも目が離せませんよ🔥」
- 「前回は${data.prev}が頭一つ抜け出していましたが、今回はその流れを受け継ぐ機種が現れるのか注目ですっ✨」
- 「${data.prev}が躍動した前回の余韻も冷めやらぬ中、今回はいったいどの機種から優秀台が飛び出すのか⁉️楽しみですね～🎉」
${(data.openCount || 0) >= 5 ? `- 「こちらは【戦極】取材の常連店🌺\n毎回ド派手な出玉で我々を魅了してくれていますので、今回の結果も非常に楽しみですっ💥」` : ''}
${prevArticle?.over10000Count >= 2 ? `- 「前回は万枚オーバーが${prevArticle.over10000Count}件と、かなりの盛り上がりを見せていました🎉今回も期待が高まりますねっ🔥」` : ''}
→ 前回機種(${data.prev})に触れて今回への期待を出すこと。${(data.openCount || 0) >= 5 ? `今回で通算${data.openCount}回目の開催という実績があるので、「常連店」として毎回の実績を称える切り口でもよい。` : '今回の開催は通算数回程度のため「常連店」という表現は使わないこと。'}${prevArticle?.over10000Count >= 2 ? `前回は万枚オーバーが${prevArticle.over10000Count}件あったので、その実績に触れてもよい。` : ''}1〜2文。上記のどれかをベースにバリエーションを出すこと。`;
      }

      const b8Section = series === 'hyakkaryoran' ? `■ b8（設置台数アピール。設置台数テーブルの直前に入る）
今回の設置情報: ${data.machineList}（${data.cnt}機種 合計${data.total}台）
実例:
- 「同店のハナ系設置は${data.cnt}機種で合計${data.total}台📝」
- 「同店に設置されている取材対象機種はキンハナ30&キンハナV30の2機種のみ📝どちらも38台ずつの設置となりますので合計で76台です✨️」（機種数が2〜3機種と少なく、かつ各機種の設置台数がほぼ均等な場合に限り、上記のように機種名を具体的に挙げて紹介するパターンも使ってよい）
→ 設置台数(${data.total}台)・機種数(${data.cnt}機種)には必ず触れること。機種数が少なく特徴的な構成なら機種名(${data.machineList})を具体的に挙げてもよいが、機種数が多い場合や台数がバラバラな場合は使わないこと。1文。` : '';

      // 東京喰種・天地神明は機種が1種類のみのためTOP1/TOP2の機種名比較ではなく、全体の稼働傾向コメントにする
      let b13Section;
      if (series === 'tokyoghoul' || series === 'tenchishinmei') {
        const machineLabel = series === 'tokyoghoul' ? '東京喰種' : 'ミリオンゴッド';
        const avgDiffInfo  = data.avgDiff != null ? `全台平均差枚: ${data.avgDiff >= 0 ? '+' : ''}${data.avgDiff}枚` : '';
        const g10000Info   = data.maxG != null && data.maxG >= 10000 ? `最高${data.maxG.toLocaleString()}Gに達した台あり` : '';
        const tierParts = [
          data.tier7000 ? `7000枚オーバー×${data.tier7000}台` : '',
          data.tier4000 ? `4000枚オーバー×${data.tier4000}台` : '',
          data.tier3000 ? `3000枚オーバー×${data.tier3000}台` : '',
        ].filter(Boolean).join('、');
        b13Section = `■ b13（TOP1・2の機種比較ではなく、全体の稼働傾向コメント。機種は${machineLabel}のみのため機種名には触れない）
${data.achieved10000 ? '※TOP1が万枚（10,000枚）オーバーを達成しています。' : ''}
今回のデータ:
${avgDiffInfo}
${g10000Info}
${tierParts ? `差枚階層: ${tierParts}` : ''}
${data.plusCount != null ? `プラス比率: ${data.total}台中${data.plusCount}台がプラス` : ''}
実例（この中から状況に合うものを1〜2個選んで組み合わせること。全部使う必要はない）:
- 「今回もまた全体的に高稼働でシマ全体が盛り上がっていました✨️\n全台平均した差枚は+1200枚オーバーでしたよ‼️」
- 「一時期に比べて少し人気が落ち着いてきた感もありますが、${eventName}開催時はまだまだ熱気に溢れております🔥🔥」
- 「ランキングのゲーム数を見てもわかるように全体的に高稼働で、${machineLabel}全体が盛り上がっていました✨️\n中には10,000Gオーバーの台もあり、きっと粘りたくなる要素があったのでしょう🔥🔥」
- 「出玉的には7000枚オーバー×1、4000枚オーバー×3、3000枚オーバー×2と、お客様にとって満足のいく形となったハズです🔥🔥🔥」
- 「トップ台は万枚オーバー達成です👏\nそして半数以上がプラスの差枚ということで、かなり優秀台が多かったようですね🔥」
${data.firstTime ? `- 「全体的に稼働もしっかりとついていたようで、初回から大盛り上がりだったと思われます☺️」` : ''}
→ 上記「今回のデータ」と矛盾しない範囲で2〜3文にまとめること。`;
      } else if (series === 'hyakkaryoran') {
        const avgDiffInfo = data.avgDiff != null ? `全台平均差枚: ${data.avgDiff >= 0 ? '+' : ''}${data.avgDiff}枚` : '';
        const highGInfo   = data.maxG != null && data.maxG >= 8000 ? `最高${data.maxG.toLocaleString()}Gに達した台あり` : '';
        b13Section = `■ b13（TOP結果への詳細コメント。以下A・Bどちらのパターンを使ってもよい。ハナ系機種は万枚オーバーが出ないため、その表現は使わないこと）

【パターンA: TOP1・2の機種比較】
実例:
- 「1位の${data.t1n}はなんと${data.t1d.replace(/\+/,'')}オーバーという結果に😲この枚数、この当たり方はさぞ楽しかった事でしょう✨また2位の${data.t2n}も差枚数${data.t2d.replace(/\+/,'')}とこちらも素晴らしい結果でした‼️」
- 「上位はゲーム数も合成確率も出玉も全て申し分ないぐらい盛り上がりましたね✨ランキング内の台は全て合成確率が超優秀という結果👏👏👏」
- 「いやはや、${data.t1n}が大暴れ😲💥首位を飾った${data.t1num}番台は絶好調な挙動をぶん回されてますねぇ👀これはお見事❗️」
→ TOP1・2の機種名・差枚数・特徴に触れて。2〜3文。

【パターンB: ハナ系全体の稼働傾向＋ランキング内の機種構成コメント】
今回のデータ:
${avgDiffInfo}
${highGInfo}
${data.rankInTop ? `ランクイン台数トップ機種: ${data.rankInTop}` : ''}
実例:
- 「また、ハナ系機種はすべてに優秀台が出現🔍\nハナ系機種は1台あたり約${data.avgDiff != null ? data.avgDiff : '1000'}枚という凄まじい結果で、店内はまさにお祭り騒ぎの様相を呈しておりましたよっ🌺🌺🌺\n上位は1万ゲーム近く回している台が多数あり、お客さんも朝から粘っていたのではないでしょうか☺️\n【${eventName}】が盛り上がっていた証拠ですね✨️\nランキングを見ると${data.rankInTop ? data.rankInTop.split('、')[0] : '{機種名}'}が目立ちますが、10位までには少数台設置の機種が半数を占めていて、どちらにも優秀台が複数潜んでいたと思われます🤔」
→ 上記「今回のデータ」(平均差枚・ゲーム数・ランクイン機種構成)と矛盾しない範囲で書くこと。ランクイン機種構成はランクイン台数トップ(${data.rankInTop || '不明'})を参考にすること。

→ A・Bどちらのパターンでもよいが、実際のデータ(TOP1・2の機種名や差枚数、または平均差枚・ランクイン構成)と矛盾しないこと。2〜4文。`;
      } else if (series === 'ikkyunyukon') {
        b13Section = `■ b13（TOP結果への詳細コメント）
実例:
- 「1位の${data.t1n}はなんと${data.t1d.replace(/\+/,'')}オーバーという結果に😲この出玉、この当たり方はさぞ楽しかった事でしょう✨また2位の${data.t2n}も差玉数${data.t2d.replace(/\+/,'')}とこちらも素晴らしい結果でした‼️」
- 「上位は出玉も当たり方も全て申し分ないぐらい盛り上がりましたね✨ランキング内の台は全て優秀な結果👏👏👏」
- 「いやはや、${data.t1n}が大暴れ😲💥首位を飾った${data.t1num}番台は絶好調な状態をぶん回されてますねぇ👀これはお見事❗️」
→ TOP1・2の機種名・差玉数・特徴に触れて。「枚数」「差枚数」ではなく「出玉」「差玉数」という表現を使うこと。「ゲーム数」「合成確率」「挙動」はスロット用語のため使わないこと。2〜3文。`;
      } else {
        b13Section = `■ b13（TOP結果への詳細コメント）
${data.achieved10000 ? '※TOP1が万枚（10,000枚）オーバーを達成しているので、「万枚オーバー達成」であることに必ず触れること。' : ''}
実例:
- 「1位の${data.t1n}はなんと${data.t1d.replace(/\+/,'')}オーバーという結果に😲この枚数、この当たり方はさぞ楽しかった事でしょう✨また2位の${data.t2n}も差枚数${data.t2d.replace(/\+/,'')}とこちらも素晴らしい結果でした‼️」
- 「上位はゲーム数も合成確率も出玉も全て申し分ないぐらい盛り上がりましたね✨ランキング内の台は全て合成確率が超優秀という結果👏👏👏」
- 「いやはや、${data.t1n}が大暴れ😲💥首位を飾った${data.t1num}番台は絶好調な挙動をぶん回されてますねぇ👀これはお見事❗️」
→ TOP1・2の機種名・差枚数・特徴に触れて。2〜3文。`;
      }

      const prompt = `あなたはパチスロ専門誌「パチ＆スロ必勝本」の取材ライター「新人編集のマモル」です。
パチスロ機種取材レポート${eventName}の吹き出しテキストを生成してください。
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

${b3Section}

${b5Section}

${b6Section}

${b8Section}

${b13Section}

【差枚数に応じた表現の基準】※b13で必ず守ること
- ${(3500*adjMul).toLocaleString()}${bodyUnit}以上: 「驚異的」「圧巻」「衝撃的」などの最大級の表現を使う
- ${(2500*adjMul).toLocaleString()}〜${(3500*adjMul-1).toLocaleString()}${bodyUnit}: 「見事な」「素晴らしい」「圧倒的な」など強めの表現
- ${(2000*adjMul).toLocaleString()}〜${(2500*adjMul-1).toLocaleString()}${bodyUnit}: 「好調な」「立派な」「堂々たる」など普通に良い表現
- ${(2000*adjMul).toLocaleString()}${bodyUnit}未満: 「堅実な」「安定した」「しっかりした」など落ち着いた表現
差枚数の数値を見て、大げさにも控えめにもならないよう適切な表現を選ぶこと。

${series === 'tenkamusou' ? '' : data.second ? `■ b9（機種構成の紹介。設置台数テーブルの直後に入る）
今回の設置情報: ${data.machineList}（最多:${data.main}、2番目:${data.second}）
実例:
- 「${data.main}が最多設置、続いて${data.second}といった機種構成になっています📝」
- 「最多設置は${data.main}で、その後を${data.second}が追う形の構成ですね📝」
- 「${data.main}を中心とした設置台数で、${data.second}と合わせてバランス良く揃っています📝」
- 「メインは${data.main}ですっ！続いて${data.second}が並ぶ布陣となっていますよ📝」
- 「設置台数トップは${data.main}、そして${data.second}と続く機種構成です📝」
- 「${data.main}がラインナップの中心を担い、${data.second}と合わさった構成となっていますね📝」
→ 最多機種(${data.main})と2番目(${data.second})を必ず含めて1文。フレンドリーな口調で毎回少し違う表現にすること。` : `■ b9（設置台数中のプラス比率アピール。設置台数テーブルの直後に入る。対象機種は${data.main}1機種のみのため機種構成比較はしないこと）
${data.plusCount != null ? `今回のデータ: ${data.total}台設置で${data.plusCount}台がプラス` : ''}
実例:
- 「${data.total}台設置で${data.plusCount}台がプラスという結果に👀」
- 「${data.plusCount}／${data.total}台がプラスと、なかなかの勝率ですねっ✨」
- 「${data.total}台中${data.plusCount}台がプラスということで、優秀台の多さがうかがえますね📝」
→ 設置台数とプラス台数の比率を必ず含めて1文。${data.plusCount != null && data.plusCount * 2 >= data.total ? '勝率は良好なので前向きな表現で。' : '勝率は控えめなので過度に煽らず落ち着いた表現で。'}`}

■ b14（締めコメント）
${data.achieved10000 === true ? '※今回は万枚オーバー達成台があるので、盛り上がりを強調すること。' : data.achieved10000 === false ? '※今回は万枚オーバー未達成なので、煽りすぎず「次回リベンジに期待」のようなフォローを入れること。' : ''}
${data.firstTime ? '※同店では今回が初開催のため、「今回も」など継続開催を前提とした表現は使わないこと。「初回から」「初開催から」など初めてであることが分かる表現にすること。' : ''}
実例:
${data.firstTime ? `- 「初回から大いに盛り上がりを見せてくれましたね〜👍${eventName}の次回開催もかなり期待できそうです！」
- 「ランキングを見る感じ、やはり設置台数が多い機種が多くランクインしている傾向に🤔次回の立ち回りの参考にしてみてくださいね☝️」
- 「初開催から多台数設置機種が優勢ではありましたが、全体的にチャンスがあった取材となりましたね☺️」
- 「初回は惜しくも万枚には届きませんでしたが、優秀台の多さは間違いなしですっ👍次回のリベンジにも期待したいですね！」` : `- 「今回もガッツリと盛り上がっていましたね〜👍同店での${eventName}開催時はかなり期待できそうです！」
- 「ランキングを見る感じ、やはり設置台数が多い機種が多くランクインしている傾向に🤔次回の立ち回りの参考にしてみてくださいね☝️」
- 「やはり多台数設置機種が優勢ではありましたが、全体的にチャンスがあった取材となりましたね☺️」
- 「惜しくも万枚には届きませんでしたが、優秀台の多さは間違いなしですっ👍次回のリベンジにも期待したいですね！」`}
${series === 'shishifunjin' ? `今回のデータ:
${data.over10000Count ? `万枚オーバー×${data.over10000Count}件` : ''}
${data.over5000Count ? `5,000枚以上×${data.over5000Count}件` : ''}
${data.rankInMinDiff != null ? `ランクイン台は全て${data.rankInMinDiff}枚以上` : ''}
追加実例（上記データに合うものがあれば1〜2個選んで組み合わせてもよい）:
- 「今回は万枚オーバーが${data.over10000Count}件と、かなりの盛り上がりを見せてくれましたっ🎉」
- 「5,000枚以上が${data.over5000Count}件と、優秀台の多さがうかがえる結果に📝」
- 「ランクイン台は全て${data.rankInMinDiff}枚以上と、粒ぞろいの結果となりましたね✨」` : ''}
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
  "b5": "...",${series === 'tokyoghoul' ? '' : `
  "b6": "...",`}${series === 'hyakkaryoran' ? `
  "b8": "...",` : ''}${series === 'tenkamusou' ? '' : `
  "b9": "...",`}
  "b13": "...",
  "b14": "...",
  "b15": "..."
}`;

      // この店舗の過去記事があればプロンプトに追加
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
        try {
          const parsed2 = JSON.parse(sanitizeAiJsonText(match[0]));
          return sendJson(200, parsed2);
        } catch(e2) {
          return sendJson(500, { error: 'JSON解析エラー', raw: text });
        }
      }
    }

    if (req.method === 'POST' && parsed.pathname === '/api/generate-text-ifudodo') {
      const apiKey = process.env.CLAUDE_API_KEY || config.claude_api_key;
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
        try {
          return sendJson(200, JSON.parse(sanitizeAiJsonText(match[0])));
        } catch(e2) {
          return sendJson(500, { error: 'JSON解析エラー', raw: text });
        }
      }
    }

    if (req.method === 'GET' && parsed.pathname === '/api/store-memory') {
      const hall = parsed.searchParams.get('hall') || '';
      const series = parsed.searchParams.get('series') || 'denkoisseki';
      const memory = readStoreMemory();
      const bucket = memory[hall];
      // シリーズ別に記憶していない旧形式（配列）は他シリーズの文章が混ざる原因になるため参照しない
      const raw = (bucket && !Array.isArray(bucket) ? bucket[series] : null);
      // 直近3件のみ保存する旧形式（配列）と、通算回数も持つ新形式（{count, items}）の両方に対応
      const items = Array.isArray(raw) ? raw : (raw?.items || []);
      const count = Array.isArray(raw) ? items.length : (raw?.count ?? items.length);
      const past = items.slice(0, 3);
      const prevTop1 = past.length > 0 ? (past[0].top1 || '') : '';
      return sendJson(200, { past, prevTop1, count });
    }

    if (req.method === 'POST' && parsed.pathname === '/api/store-memory') {
      const buf = await collectBody(req);
      const { hall, series, date, texts, top1, over10000Count } = JSON.parse(buf.toString('utf8'));
      const seriesKey = series || 'denkoisseki';
      const memory = readStoreMemory();
      if (!memory[hall] || Array.isArray(memory[hall])) memory[hall] = {};
      const existing = memory[hall][seriesKey];
      const prevItems = Array.isArray(existing) ? existing : (existing?.items || []);
      const prevCount = Array.isArray(existing) ? prevItems.length : (existing?.count ?? prevItems.length);
      const items = [{ date, texts, top1: top1 || '', over10000Count: over10000Count || 0 }, ...prevItems].slice(0, 3);
      memory[hall][seriesKey] = { count: prevCount + 1, items };
      writeStoreMemory(memory);
      return sendJson(200, { ok: true });
    }

    // ── PISION（P-PRO）ホール検索 ──────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/pision-halls') {
      const q = (parsed.searchParams.get('q') || '').trim();
      if (!q) return sendJson(400, { error: 'q（店舗名）が必要です' });
      const halls = await pisionRequest(`/api/v2/halls`);
      const matches = (halls.halls || []).filter(h => h.name.includes(q));
      return sendJson(200, { halls: matches.slice(0, 20) });
    }

    // ── PISION（P-PRO）結果取得 ────────────────────────────────────
    if (req.method === 'GET' && parsed.pathname === '/api/pision-results') {
      const hallId = parsed.searchParams.get('hallId');
      const date = parsed.searchParams.get('date');
      if (!hallId || !date) return sendJson(400, { error: 'hallId・dateが必要です' });
      const result = await pisionRequest(`/api/v2/halls/${encodeURIComponent(hallId)}/results/${encodeURIComponent(date)}`);
      const roundUp50 = v => v >= 0 ? Math.ceil(v / 50) * 50 : Math.floor(v / 50) * 50;
      const machines = (result.details || []).map(d => ({
        台番: d.unitId,
        機種名: d.model?.name || d.displayName || '',
        表示名: d.model?.name || d.displayName || '',
        差: roundUp50(d.diff ?? 0),
        colored: false,
        G数: d.games ?? null,
        BB: d.bb ?? null,
        RB: d.rb ?? null,
        points: d.points || [],
      })).sort((a, b) => a.台番 - b.台番);
      return sendJson(200, { hall: result.hall, targetDate: result.targetDate, machines });
    }

    // ── PISION（P-PRO）速報データ取得（結果IDから直接取得。速報一覧のarticles/:idに対応） ──
    if (req.method === 'GET' && parsed.pathname === '/api/pision-result-by-id') {
      const id = parsed.searchParams.get('id');
      if (!id) return sendJson(400, { error: 'idが必要です' });
      const result = await pisionRequest(`/api/v2/results/${encodeURIComponent(id)}`);
      const roundUp50 = v => v >= 0 ? Math.ceil(v / 50) * 50 : Math.floor(v / 50) * 50;
      const machines = (result.details || []).map(d => ({
        台番: d.unitId,
        機種名: d.model?.name || d.displayName || '',
        表示名: d.model?.name || d.displayName || '',
        差: roundUp50(d.diff ?? 0),
        colored: false,
        G数: d.games ?? null,
        BB: d.bb ?? null,
        RB: d.rb ?? null,
        points: d.points || [],
      })).sort((a, b) => a.台番 - b.台番);
      return sendJson(200, { hall: result.hall, targetDate: result.targetDate, machines });
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
