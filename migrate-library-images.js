// 一度だけ実行する移行スクリプト: article-data/library.json と pickup-data/library.json に
// 埋め込まれているbase64画像を library-images/ 配下の個別ファイルに書き出し、
// JSON側は参照パスだけを持つ軽量な形に変換する。
const fs = require('fs');
const path = require('path');
const { convertImagesTree } = require('./lib-image-store');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

function migrate(relFile, subdir, nested) {
  const full = path.join(DATA_DIR, relFile);
  if (!fs.existsSync(full)) { console.log(`${relFile}: ファイルなし、スキップ`); return; }
  const before = fs.statSync(full).size;
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  const stats = convertImagesTree(data.images, subdir, nested);
  fs.writeFileSync(full, JSON.stringify(data), 'utf8');
  const after = fs.statSync(full).size;
  console.log(`${relFile}: ${stats.converted}枚を変換, ${before.toLocaleString()} -> ${after.toLocaleString()} bytes`);
}

migrate('article-data/library.json', 'article', true);
migrate('pickup-data/library.json', 'pickup', false);
