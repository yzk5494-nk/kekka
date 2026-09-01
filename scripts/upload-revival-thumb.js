// リバイバル各バリエーションのアイキャッチ画像をhisshobon-hall.infoにアップロードするワンショットスクリプト
// 使い方: node scripts/upload-revival-thumb.js <ローカル画像パス> <ファイル名(WP保存用)>
const fs = require('fs');
const https = require('https');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'wp-config.json'), 'utf8'));
const HB = config.hisshobon;
const HB_AUTH = Buffer.from(`${HB.username}:${HB.password}`).toString('base64');

const [,, filePath, wpFilename] = process.argv;
if (!filePath || !wpFilename) {
  console.error('使い方: node scripts/upload-revival-thumb.js <ローカル画像パス> <ファイル名(拡張子含む)>');
  process.exit(1);
}

const imgBuf = fs.readFileSync(filePath);
const ext = path.extname(wpFilename).toLowerCase();
const contentType = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';

const urlObj = new URL(HB.url + '/wp-json/wp/v2/media');
const req = https.request({
  hostname: urlObj.hostname,
  path: urlObj.pathname,
  method: 'POST',
  headers: {
    'Authorization': `Basic ${HB_AUTH}`,
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${wpFilename}"`,
    'Content-Length': imgBuf.length,
  },
}, (res) => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      const data = JSON.parse(raw);
      console.log(JSON.stringify({ status: res.statusCode, id: data.id, source_url: data.source_url, error: data.message }, null, 2));
    } catch (e) {
      console.log('status', res.statusCode, raw.slice(0, 500));
    }
  });
});
req.on('error', e => console.error('error', e));
req.write(imgBuf);
req.end();
