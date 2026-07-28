// YGブログ（yg-blog.com）の投稿から蓄積する店舗別実績データベース
// Node組み込みの node:sqlite を使用（better-sqlite3はこの開発機にVisual Studioビルドツールがなくインストール不可だったため）
//
// データ構造：記事（店舗・取材名・日付）→グループ（1回の「WP投稿」操作で選ばれた台の集まり）→台（機種名・差枚など）
// resultsに保存するのは店舗の全台データではなく、yg-poster.htmlで「ピックアップ」された機種のみ
// （全台/一部の取得方法が記事ごとに異なり、全台データとしての一貫性を保証できないため）
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_FILE = path.join(DATA_DIR, 'hall-analytics.db');

const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    pision_hall_id TEXT
  );
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    coverage_name TEXT NOT NULL,
    date TEXT NOT NULL,
    wp_post_id INTEGER,
    link TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(store_id, coverage_name, date)
  );
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    unit_no INTEGER,
    machine_name TEXT,
    display_name TEXT,
    diff INTEGER,
    games INTEGER,
    bb INTEGER,
    rb INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_groups_article ON groups(article_id);
  CREATE INDEX IF NOT EXISTS idx_results_group ON results(group_id);
`);

function getOrCreateStoreId(name, pisionHallId) {
  db.prepare('INSERT OR IGNORE INTO stores(name, pision_hall_id) VALUES (?, ?)').run(name, pisionHallId || null);
  const row = db.prepare('SELECT id, pision_hall_id FROM stores WHERE name = ?').get(name);
  if (pisionHallId && !row.pision_hall_id) {
    db.prepare('UPDATE stores SET pision_hall_id = ? WHERE id = ?').run(pisionHallId, row.id);
  }
  return row.id;
}

// groups: 台オブジェクトの配列の配列（1グループ = 1回のWP投稿操作で選ばれた台の集まり）
function upsertArticleAndGroups({ storeName, pisionHallId, coverageName, date, wpPostId, link, groups }) {
  if (!storeName || !coverageName || !date) return;
  try {
    db.exec('BEGIN');
    const storeId = getOrCreateStoreId(storeName, pisionHallId);

    const existing = db.prepare('SELECT id FROM articles WHERE store_id = ? AND coverage_name = ? AND date = ?')
      .get(storeId, coverageName, date);
    let articleId;
    if (existing) {
      articleId = existing.id;
      db.prepare('DELETE FROM groups WHERE article_id = ?').run(articleId); // ON DELETE CASCADEでresultsも削除される
      db.prepare('UPDATE articles SET wp_post_id = ?, link = ?, created_at = datetime(\'now\') WHERE id = ?')
        .run(wpPostId || null, link || null, articleId);
    } else {
      const info = db.prepare('INSERT INTO articles(store_id, coverage_name, date, wp_post_id, link) VALUES (?, ?, ?, ?, ?)')
        .run(storeId, coverageName, date, wpPostId || null, link || null);
      articleId = Number(info.lastInsertRowid);
    }

    const insertGroup = db.prepare('INSERT INTO groups(article_id) VALUES (?)');
    const insertResult = db.prepare(
      'INSERT INTO results(group_id, unit_no, machine_name, display_name, diff, games, bb, rb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const group of (groups || [])) {
      if (!group || !group.length) continue;
      const groupInfo = insertGroup.run(articleId);
      const groupId = Number(groupInfo.lastInsertRowid);
      for (const m of group) {
        insertResult.run(
          groupId,
          m.台番 ?? null,
          m.機種名 || null,
          m.表示名 || null,
          m.差 ?? null,
          m.G数 ?? null,
          m.BB ?? null,
          m.RB ?? null,
        );
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function listStores() {
  return db.prepare(`
    SELECT s.name AS name,
           COUNT(DISTINCT a.id) AS articleCount,
           MIN(a.date) AS firstDate,
           MAX(a.date) AS lastDate
    FROM stores s
    JOIN articles a ON a.store_id = s.id
    GROUP BY s.id
    ORDER BY articleCount DESC, s.name ASC
  `).all();
}

function listCoverageNames(storeName) {
  return db.prepare(`
    SELECT a.coverage_name AS coverageName,
           COUNT(*) AS articleCount,
           MIN(a.date) AS firstDate,
           MAX(a.date) AS lastDate
    FROM articles a
    JOIN stores s ON s.id = a.store_id
    WHERE s.name = ?
    GROUP BY a.coverage_name
    ORDER BY articleCount DESC, a.coverage_name ASC
  `).all(storeName);
}

function getDetail(storeName, coverageName) {
  const summary = db.prepare(`
    SELECT COUNT(*) AS articleCount, MIN(a.date) AS firstDate, MAX(a.date) AS lastDate
    FROM articles a
    JOIN stores s ON s.id = a.store_id
    WHERE s.name = ? AND a.coverage_name = ?
  `).get(storeName, coverageName);
  if (!summary || !summary.articleCount) return null;

  const machines = db.prepare(`
    SELECT
      COALESCE(NULLIF(r.display_name, ''), r.machine_name) AS displayName,
      COUNT(DISTINCT a.id) AS appearances,
      AVG(r.diff) AS avgDiff,
      SUM(r.diff) AS totalDiff,
      MAX(r.diff) AS maxDiff
    FROM results r
    JOIN groups g ON g.id = r.group_id
    JOIN articles a ON a.id = g.article_id
    JOIN stores s ON s.id = a.store_id
    WHERE s.name = ? AND a.coverage_name = ? AND COALESCE(NULLIF(r.display_name, ''), r.machine_name) IS NOT NULL
    GROUP BY displayName
    ORDER BY appearances DESC, avgDiff DESC
  `).all(storeName, coverageName).map(m => ({
    displayName: m.displayName,
    appearances: m.appearances,
    pickupRate: summary.articleCount ? m.appearances / summary.articleCount : 0,
    avgDiff: Math.round(m.avgDiff),
    totalDiff: m.totalDiff,
    maxDiff: m.maxDiff,
  }));

  return { store: storeName, coverageName, summary, machines };
}

module.exports = { upsertArticleAndGroups, listStores, listCoverageNames, getDetail };
