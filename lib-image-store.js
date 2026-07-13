// ライブラリ画像を個別ファイルとして保存し、JSON側には参照パスだけを持たせるための共通処理。
// 既存データの一括移行（migrate-library-images.js）と、保存時のオンザフライ変換（wp-poster.js）の両方から使う。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Railwayの永続ボリュームがマウントされていればそちら配下に保存する（wp-poster.jsのDATA_DIRと同じルール）
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const LIB_IMAGES_DIR = path.join(DATA_DIR, 'library-images');

function mimeToExt(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'bin';
}

// data URI文字列をファイルに保存し、参照パス（/library-images/...）を返す。
// すでに参照パス・その他の形式ならそのまま返す（変換不要）。
function persistImageValue(subdir, value) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!m) return value;
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const hash = crypto.createHash('md5').update(buf).digest('hex');
  const ext = mimeToExt(mime);
  const dir = path.join(LIB_IMAGES_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.${ext}`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buf);
  return `/library-images/${subdir}/${hash}.${ext}`;
}

// images ツリーを走査し、埋め込みbase64をファイル化して参照に置き換える（破壊的）。
// nested=true: { [series]: { [machineName]: {url, endImages} } }
// nested=false: { [machineName]: {url, endImages} }
function convertImagesTree(images, subdir, nested) {
  let converted = 0, charsBefore = 0, charsAfter = 0;
  if (!images) return { converted, charsBefore, charsAfter };

  // エントリーは {url, endImages, ...} のオブジェクト形式のこともあれば、
  // base64のdata URIが直接値として入っている（裸の文字列）こともある。両方に対応する。
  const processValue = (entry) => {
    if (typeof entry === 'string') {
      if (entry.startsWith('data:')) {
        charsBefore += entry.length;
        const ref = persistImageValue(subdir, entry);
        charsAfter += ref.length;
        converted++;
        return ref;
      }
      return entry;
    }
    if (!entry || typeof entry !== 'object') return entry;
    if (typeof entry.url === 'string' && entry.url.startsWith('data:')) {
      charsBefore += entry.url.length;
      entry.url = persistImageValue(subdir, entry.url);
      charsAfter += entry.url.length;
      converted++;
    }
    if (Array.isArray(entry.endImages)) {
      entry.endImages = entry.endImages.map(e => {
        if (typeof e === 'string' && e.startsWith('data:')) {
          charsBefore += e.length;
          const ref = persistImageValue(subdir, e);
          charsAfter += ref.length;
          converted++;
          return ref;
        }
        return e;
      });
    }
    return entry;
  };

  if (nested) {
    for (const seriesKey of Object.keys(images)) {
      for (const name of Object.keys(images[seriesKey])) {
        images[seriesKey][name] = processValue(images[seriesKey][name]);
      }
    }
  } else {
    for (const name of Object.keys(images)) {
      images[name] = processValue(images[name]);
    }
  }
  return { converted, charsBefore, charsAfter };
}

module.exports = { persistImageValue, convertImagesTree, LIB_IMAGES_DIR, mimeToExt };
