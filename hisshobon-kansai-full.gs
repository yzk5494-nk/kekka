/**
 * 必勝本ハック（hisshobon-hall.info）関西エリア（大阪・京都・兵庫・滋賀・奈良・和歌山）の
 * スケジュールを毎日スクレイピングし、対応する月シート（「シン・M月」形式）の
 * C列(ホール名)・D列(取材)・E列(来店・収録)に自動書き込みする。
 * 企画名によるキーワード絞り込みはせず全件取得し、企画名に「来店」または「収録」を
 * 含むものはE列、それ以外はD列に振り分ける。
 *
 * このシートは他人から共有されたファイルだが、Webアプリのデプロイと違い
 * 時間主導型トリガーの作成はファイル編集権限があれば実行できるため、
 * コンテナバインド型スクリプト(スプレッドシートの拡張機能から開くApps Script)で
 * そのまま動作する。
 *
 * 【セットアップ手順】
 * 1. スプレッドシートを開き、「拡張機能」→「Apps Script」を開く
 * 2. デフォルトの Code.gs の中身をこのファイルの内容に置き換える（保存）
 * 3. 関数選択で setupDailyTrigger を選び、実行ボタン(▷)を押す
 *    → 初回はGoogleの権限承認画面が出るので許可する
 *    → これで毎日自動実行されるようになる
 * 4. 動作確認したい場合は scrapeAndFill を直接実行してもよい
 */

function listSheetNames() {
  const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  sheets.forEach(function (s) {
    Logger.log('[' + s.getName() + ']');
  });
}

const KANSAI_URL = 'https://hisshobon-hall.info/category/kansai/';
const HALL_COL = 3;   // C列: ホール名
const KIZAI_COL = 4;  // D列: 取材
const RAITEN_COL = 5; // E列: 来店・収録

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scrapeAndFill') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scrapeAndFill')
      .timeBased()
      .everyDays(1)
      .atHour(6)
      .create();
}

// 企画名に「来店」または「収録」を含むかどうかで、E列(来店・収録)扱いにするか判定する
function isRaitenEvent(eventName) {
  return eventName.indexOf('来店') !== -1 || eventName.indexOf('収録') !== -1;
}

function scrapeAndFill() {
  const html = UrlFetchApp.fetch(KANSAI_URL).getContentText();
  Logger.log('取得した文字数: ' + html.length);
  const scheduleHtml = extractScheduleSection(html);
  Logger.log('スケジュール範囲の文字数: ' + scheduleHtml.length);
  const entries = parseEntries(scheduleHtml);
  Logger.log('パース件数: ' + entries.length);
  entries.slice(0, 5).forEach(function (e) {
    Logger.log('例: ' + e.month + '/' + e.day + ' ' + e.hallName + ' / ' + e.eventName);
  });
  entries.forEach(function (entry) {
    writeEntry(entry.month, entry.day, entry.hallName, entry.eventName);
  });
}

// 「スケジュール」見出しから次の見出し(「レポート」など)までの範囲だけを対象にする。
// レポート欄は日付・ホール名・企画名の並び順が異なるため除外が必要。
function extractScheduleSection(html) {
  const start = html.indexOf('スケジュール</h2>');
  if (start === -1) return html;
  const nextHeadingIdx = html.indexOf('wp-block-heading', start + 1);
  if (nextHeadingIdx === -1) return html.substring(start);
  const end = html.lastIndexOf('<h2', nextHeadingIdx);
  return html.substring(start, end === -1 ? html.length : end);
}

// フォーマットは「MM/DD｜ホール名｜府県名｜企画名」。3番目の府県名フィールドは
// 書き込みには使わない（C/D/E列に書くのはホール名と企画名のみ）ため読み捨てる。
function parseEntries(sectionHtml) {
  const regex = /<h2 class="p-postList__title">(\d{2})\/(\d{2})｜([^｜]+)｜[^｜]+｜([^<]+)<\/h2>/g;
  const entries = [];
  let m;
  while ((m = regex.exec(sectionHtml)) !== null) {
    entries.push({
      month: parseInt(m[1], 10),
      day: parseInt(m[2], 10),
      hallName: m[3].trim(),
      eventName: m[4].trim()
    });
  }
  return entries;
}

// 月シート名は「シン・M月」形式（例：シン・9月）
function resolveSheetName(month) {
  return 'シン・' + month + '月';
}

function writeEntry(month, day, hallName, eventName) {
  const sheetName = resolveSheetName(month);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('[スキップ] シートが見つからない: ' + sheetName);
    return;
  }

  const block = findDayBlock(sheet, day);
  if (!block) {
    Logger.log('[スキップ] ' + sheetName + ' に ' + day + '日のブロックが見つからない: ' + hallName + ' / ' + eventName);
    return;
  }

  const targetCol = isRaitenEvent(eventName) ? RAITEN_COL : KIZAI_COL;

  if (isAlreadyRegistered(sheet, block, hallName, eventName, targetCol)) {
    Logger.log('[スキップ] 登録済み: ' + hallName + ' / ' + eventName);
    return;
  }

  const targetRow = findEmptyRowInBlock(sheet, block) || expandBlock(sheet, block);
  sheet.getRange(targetRow, HALL_COL).setValue(hallName);
  sheet.getRange(targetRow, targetCol).setValue(eventName);
  Logger.log('[書き込み] ' + sheetName + ' ' + targetRow + '行目(' + (targetCol === RAITEN_COL ? 'E' : 'D') + '列): ' + hallName + ' / ' + eventName);
}

// 同じ日のブロック内に同一のホール名・企画名（同じ列＝取材/来店の種別も一致）が
// 既にあれば重複とみなす(毎日同じ掲載が続くサイトのため、これがないと日次実行のたびに増殖してしまう)
function isAlreadyRegistered(sheet, block, hallName, eventName, targetCol) {
  const values = sheet.getRange(block.startRow, HALL_COL, block.numRows, 3).getValues();
  const targetColIdx = targetCol - HALL_COL; // C基準の相対列(D=1, E=2)
  return values.some(function (row) {
    return row[0] === hallName && row[targetColIdx] === eventName;
  });
}

// A列の結合範囲から、指定の日にちの表記("4日"など)に一致するブロックを探す。
// 元データに " 2日" のような余分な空白が入っているケースがあるためtrimして比較する。
function findDayBlock(sheet, day) {
  const lastRow = sheet.getLastRow();
  const colA = sheet.getRange(2, 1, lastRow - 1, 1); // 1行目はヘッダーなので除外
  const mergedRanges = colA.getMergedRanges();
  const target = day + '日';
  for (let i = 0; i < mergedRanges.length; i++) {
    const range = mergedRanges[i];
    if (range.getCell(1, 1).getDisplayValue().trim() === target) {
      return { startRow: range.getRow(), numRows: range.getNumRows() };
    }
  }
  return null;
}

// ブロック内でC列(ホール名)が空いている最初の行番号を返す(なければnull)
function findEmptyRowInBlock(sheet, block) {
  const values = sheet.getRange(block.startRow, HALL_COL, block.numRows, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) {
      return block.startRow + i;
    }
  }
  return null;
}

// ブロックに空きがない場合、ブロック末尾に1行挿入して結合範囲を拡張し、
// 追加した行番号を返す
function expandBlock(sheet, block) {
  const lastRowOfBlock = block.startRow + block.numRows - 1;
  const dayValue = sheet.getRange(block.startRow, 1).getValue();
  const weekdayValue = sheet.getRange(block.startRow, 2).getValue();

  sheet.getRange(block.startRow, 1, block.numRows, 2).breakApart();
  sheet.insertRowAfter(lastRowOfBlock);
  const newRow = lastRowOfBlock + 1;

  const newNumRows = block.numRows + 1;
  sheet.getRange(block.startRow, 1, newNumRows, 1).merge().setValue(dayValue);
  sheet.getRange(block.startRow, 2, newNumRows, 1).merge().setValue(weekdayValue);

  return newRow;
}
