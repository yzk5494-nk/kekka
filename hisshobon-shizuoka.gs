/**
 * 必勝本ハック（hisshobon-hall.info）静岡エリアのスケジュールを毎日取得し、
 * 対応する月シートのD列(ホール名)・E列(企画名)に自動書き込みする。
 *
 * 2026-10-28からhisshobon-hall.info側（XSERVER）のセキュリティ強化で、GASからの
 * ページ取得が「501 Not Implemented」で拒否されるようになったため、
 * 記事ジェネレーターのサーバー（Railway）経由でスケジュール一覧を取得する方式に変更。
 * サーバーはWordPressのAPIから、カテゴリーページの「スケジュール」欄と同じ内容を返す。
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

function testWriteMarker() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('7月');
  Logger.log('シート名: ' + (sheet ? sheet.getName() : 'null'));
  sheet.getRange('N1').setValue('TEST-' + new Date().getTime());
  Logger.log('N1に書き込み完了');
}

const SCHEDULE_API_URL = 'https://kekka-production.up.railway.app/api/hb-schedule?area=sizuoka';
const HALL_COL = 4;   // D列: ホール名
const EVENT_COL = 5;  // E列: イベント・演者名

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

function scrapeAndFill() {
  const entries = fetchEntries();
  Logger.log('取得できた件数: ' + entries.length);
  entries.slice(0, 5).forEach(function (e) {
    Logger.log('例: ' + e.month + '/' + e.day + ' ' + e.hallName + ' / ' + e.eventName);
  });
  entries.forEach(function (entry) {
    writeEntry(entry.month, entry.day, entry.hallName, entry.eventName);
  });
}

// サーバーから { entries: [{ month, day, hallName, eventName }, ...] } 形式で受け取る
function fetchEntries() {
  const res = UrlFetchApp.fetch(SCHEDULE_API_URL, { muteHttpExceptions: true });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    throw new Error('スケジュール取得に失敗しました（' + code + '）: ' + text.substring(0, 300));
  }
  return JSON.parse(text).entries || [];
}

// サイトの日付には年が含まれないため、現在の年から推測する。
// 現在月より大きく手前の月(例: 12月にスクレイピングして1月の予定が出てきた場合)は翌年とみなす。
function resolveSheetName(month) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const year = (month < currentMonth - 6) ? now.getFullYear() + 1 : now.getFullYear();
  return year + '年' + month + '月';
}

function writeEntry(month, day, hallName, eventName) {
  const sheetName = resolveSheetName(month);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return;

  const block = findDayBlock(sheet, day);
  if (!block) return;

  if (isAlreadyRegistered(sheet, block, hallName, eventName)) return;

  const targetRow = findEmptyRowInBlock(sheet, block) || expandBlock(sheet, block);
  sheet.getRange(targetRow, HALL_COL).setValue(hallName);
  sheet.getRange(targetRow, EVENT_COL).setValue(eventName);
}

// 同じ日のブロック内に同一のホール名・企画名が既にあれば重複とみなす
// (毎日同じ掲載が続くサイトのため、これがないと日次実行のたびに増殖してしまう)
function isAlreadyRegistered(sheet, block, hallName, eventName) {
  const values = sheet.getRange(block.startRow, HALL_COL, block.numRows, 2).getValues();
  return values.some(function (row) {
    return row[0] === hallName && row[1] === eventName;
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

// ブロック内でD列が空いている最初の行番号を返す(なければnull)
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
