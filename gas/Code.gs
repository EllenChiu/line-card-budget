// All money is stored internally as integer cents. No external libraries needed.
var HEADERS = ['事件ID','記錄時間','操作','卡別','金額','項目','消費日期','結帳日','每期上限','撤銷事件ID','資料JSON','回覆'];
var HELP = "信用卡記帳｜使用說明\n━━━━━━━━━━━━━━\n\n1. 新增／修改卡片\n\n格式：\n指令 卡片名稱 結帳日 刷卡上限\n\n範例：\n新增卡片 玉山 23 3000\n修改卡片 玉山 23 4000\n\n────────────────\n\n2. 紀錄刷卡\n\n格式：\n卡片名稱 刷卡項目 金額 [刷卡日]\n\n範例：\n玉山 蝦皮 599\n玉山 蝦皮 599 20260920\n\n不填日期，預設為今天。\n指定日期請使用 YYYYMMDD。\n\n────────────────\n\n3. 查詢與撤銷\n\n查詢\n查看所有卡片的本期用量。\n\n撤銷上一筆\n撤銷最近一筆尚未撤銷的消費。\n\n撤銷(玉山 蝦皮 599)\n指定撤銷括號內的原始記帳訊息。\n原本有填日期，撤銷時也要保留。\n若有多筆相同紀錄，撤銷最近一筆。\n\n說明\n查看這份使用說明。\n\n━━━━━━━━━━━━━━\n結帳日當天算本期。\n依台灣時間與手動記帳日期統計。\n每次記帳後，回覆各卡用量及超額提醒。";

var EXPENSE_HEADERS = ['事件ID','記錄時間','卡別','金額','項目','消費日期','狀態'];
var TIME_FORMAT = 'yyyy-mm-dd hh:mm:ss';
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SPREADSHEET_ID')) throw new Error('請先設定 SPREADSHEET_ID');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var book = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
    book.setSpreadsheetTimeZone('Asia/Taipei');
    var log = book.getSheetByName('操作紀錄');
    var old = book.getSheetByName('記帳紀錄');
    // Rename the original ledger without deleting or changing its event order.
    if (!log && old && old.getLastRow() && old.getRange(1,3).getValue() === '操作') {
      old.setName('操作紀錄');
      log = old;
    }
    if (!log) log = book.insertSheet('操作紀錄');
    if (!log.getLastRow()) {
      log.appendRow(HEADERS);
      log.setFrozenRows(1);
      log.getRange(1,1,1,HEADERS.length).setFontWeight('bold').setBackground('#dbeafe');
      log.hideColumns(11,2);
    }
    var rows = readLog_(log);
    if (rows.length) {
      var times = rows.map(function(row) { return [timestamp_(row[1])]; });
      log.getRange(2,2,rows.length,1).setValues(times).setNumberFormat(TIME_FORMAT);
      rows.forEach(function(row,i) { row[1] = times[i][0]; });
    }
    syncExpenses_(book,rows);
    var diagnostic = book.getSheetByName('系統診斷');
    if (diagnostic && diagnostic.getLastRow() > 1) {
      var range = diagnostic.getRange(2,1,diagnostic.getLastRow()-1,1);
      range.setValues(range.getValues().map(function(row) { return [timestamp_(row[0])]; })).setNumberFormat(TIME_FORMAT);
    }
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}
function timestamp_(value) {
  var date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid stored timestamp');
  return date;
}
function readLog_(sheet) {
  return sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,HEADERS.length).getValues() : [];
}
function expenseRows_(rows) {
  var voided = Object.create(null);
  rows.forEach(function(row) {
    var op = JSON.parse(row[10]);
    if (op.type === '撤銷') voided[op.target] = true;
  });
  return rows.filter(function(row) { return JSON.parse(row[10]).type === '消費'; }).map(function(row) {
    var op = JSON.parse(row[10]);
    return [row[0],timestamp_(row[1]),safeCell_(op.card),op.cents/100,safeCell_(op.item),op.date,voided[op.id] ? '已撤銷' : '有效'];
  });
}
function syncExpenses_(book,rows) {
  var data = expenseRows_(rows);
  var sheet = book.getSheetByName('記帳紀錄') || book.insertSheet('記帳紀錄');
  if (sheet.getLastRow() && sheet.getRange(1,3).getValue() === '操作') throw new Error('Legacy ledger still present; run setup before processing');
  var oldLast = sheet.getLastRow();
  sheet.getRange(1,1,data.length+1,EXPENSE_HEADERS.length).setValues([EXPENSE_HEADERS].concat(data));
  if (oldLast > data.length+1) sheet.getRange(data.length+2,1,oldLast-data.length-1,EXPENSE_HEADERS.length).clearContent();
  if (data.length) sheet.getRange(2,2,data.length,1).setNumberFormat(TIME_FORMAT);
  sheet.setFrozenRows(1);
}

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('WEBHOOK_SECRET');
  var owner = props.getProperty('ALLOWED_USER_ID');
  var token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!secret || !owner || !token) throw new Error('Missing script properties');
  if (!e || !e.parameter || e.parameter.key !== secret) {
    console.warn('Webhook rejected: URL key does not match WEBHOOK_SECRET');
    return output_('Unauthorized');
  }
  var input = JSON.parse(e.postData.contents);
  if (!Array.isArray(input.events)) throw new Error('Invalid events');
  console.log('Webhook received: ' + input.events.length + ' events');
  var failed = false;
  input.events.forEach(function(event) {
    if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') return;
    if (!event.source || event.source.type !== 'user') {
      console.log('Event ignored: private chat required');
      return;
    }
    if (event.source.userId !== owner) {
      console.warn('Event ignored: user does not match ALLOWED_USER_ID');
      return;
    }
    if (!event.webhookEventId || !event.replyToken || !Number.isFinite(event.timestamp) || typeof event.message.text !== 'string') return;
    var stage = '記帳';
    try {
      var text = recordEvent_(event, props);
      stage = '回覆 LINE';
      reply_(event.replyToken, text, token);
      console.log('Event processed: record saved and LINE reply accepted');
    } catch (err) {
      // Do not log the webhook URL, secrets, LINE IDs or message contents.
      var detail = diagnosticMessage_(err);
      console.error('Event failed: ' + detail);
      try { writeDiagnostic_(stage, detail); } catch (ignored) { console.error('Cannot write diagnostic sheet'); }
      failed = true;
    }
  });
  if (failed) throw new Error('One or more events failed; check execution logs');
  // HtmlOutput avoids ContentService's redirect to googleusercontent.com.
  return output_('OK');
}
function output_(text) { return HtmlService.createHtmlOutput(text); }
function diagnosticMessage_(err) {
  var message = String(err && err.message || '');
  var http = message.match(/LINE (?:reply|connection) HTTP (\d{3})/);
  if (http) {
    var hints = {'400':'請求被拒絕；回覆時可能是 reply token 過期、已使用或與 channel 不符。',
      '401':'Channel access token 無效或已失效；請確認不是 Channel secret。',
      '403':'LINE 拒絕存取，請檢查 channel 與 token 權限。',
      '429':'LINE 請求次數受限，請稍後再試。'};
    return 'LINE HTTP '+http[1]+'：'+(hints[http[1]] || 'LINE 服務錯誤，請稍後重試。');
  }
  if (/permission|authorization|authorized|script.external_request|權限|授權/i.test(message)) return 'Google 授權不足：更新 appsscript.json 的 script.external_request 權限，在編輯器執行 diagnoseConnection 授權，再部署新版本。';
  if (/Run setup first/.test(message)) return '尚未建立記帳紀錄，請執行 setup。';
  if (/Missing token/.test(message)) return '缺少 LINE_CHANNEL_ACCESS_TOKEN 指令碼屬性。';
  if (/timeout|timed out|逾時/i.test(message)) return '服務逾時；請先查詢確認是否已記帳。';
  return '未分類錯誤（'+String(err && err.name || 'Error').replace(/[^a-zA-Z]/g,'')+'）；請在編輯器執行 diagnoseConnection 檢查連線。';
}
function writeDiagnostic_(stage, detail) {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var book = SpreadsheetApp.openById(id);
    var sheet = book.getSheetByName('系統診斷') || book.insertSheet('系統診斷');
    if (!sheet.getLastRow()) sheet.appendRow(['時間','階段','診斷結果']);
    sheet.appendRow([new Date(),stage,detail]);
    sheet.getRange(sheet.getLastRow(),1).setNumberFormat(TIME_FORMAT);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}
// Run manually in the editor. Reads bot information; does not send a message.
// Run once ONLY when reauthorizing this project, then run diagnoseConnection.
// Revokes the current user's authorization; does not delete sheet data.
function resetAuthorization() {
  ScriptApp.invalidateAuth();
}

function diagnoseConnection() {
  var result;
  try {
    var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
    if (!token) throw new Error('Missing token');
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      headers:{Authorization:'Bearer '+token},muteHttpExceptions:true
    });
    var status = response.getResponseCode();
    if (status !== 200) throw new Error('LINE connection HTTP '+status);
    result = '連線成功：GAS 可呼叫 LINE，access token 有效。這不代表 webhook 的 reply token 有效，仍需傳「說明」測試。';
  } catch (err) { result = diagnosticMessage_(err) + '\n原始錯誤：' + redactDiagnostic_(err); }
  console.log(result);
  writeDiagnostic_('編輯器連線檢查',result);
  return result;
}
function redactDiagnostic_(err) {
  var text = String(err && err.message || err);
  var values = PropertiesService.getScriptProperties().getProperties();
  Object.keys(values).forEach(function(key) {
    if (values[key]) text = text.split(values[key]).join('[已隱藏]');
  });
  return text.replace(/Bearer\s+\S+/gi,'Bearer [已隱藏]')
    .replace(/([?&]key=)[^\s&#]+/gi,'$1[已隱藏]').slice(0,2000);
}
function reply_(replyToken, text, token) {
  var messages = [];
  for (var i = 0; i < text.length; i += 4500) messages.push({type:'text', text:text.slice(i,i+4500)});
  if (messages.length > 5) throw new Error('Reply too long');
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method:'post', contentType:'application/json',
    headers:{Authorization:'Bearer ' + token},
    payload:JSON.stringify({replyToken:replyToken,messages:messages}), muteHttpExceptions:true
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) throw new Error('LINE reply HTTP ' + status);
}
function recordEvent_(event, props) {
  var lock;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    var book = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
    var sheet = book.getSheetByName('操作紀錄');
    if (!sheet) throw new Error('Run setup first');
    var rows = readLog_(sheet);
    var existing = rows.find(function(row) { return row[0] === event.webhookEventId; });
    if (existing) {
      syncExpenses_(book,rows);
      return existing[11];
    }
    var state = replay_(rows.map(function(row) { return JSON.parse(row[10]); }));
    var today = Utilities.formatDate(new Date(event.timestamp), 'Asia/Taipei', 'yyyy-MM-dd');
    var sheetUrl = props.getProperty('SPREADSHEET_URL') || 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(props.getProperty('SPREADSHEET_ID')) + '/edit';
    if (!/^https:\/\/\S+$/.test(sheetUrl)) throw new Error('SPREADSHEET_URL must be an HTTPS URL');
    var result = command_(state, event.message.text, today, event.webhookEventId, sheetUrl);
    var op = result.op || {type:result.text.indexOf('❌') === 0 ? '指令錯誤' : /^(說明|help)$/.test(event.message.text.trim()) ? '說明' : '查詢'};
    var record = [event.webhookEventId, new Date(event.timestamp), op.type, safeCell_(op.card || ''), op.cents === undefined ? '' : op.cents / 100, safeCell_(op.item || ''), op.date || '', op.day || '', op.limit === undefined ? '' : op.limit / 100, op.target || '', JSON.stringify(op), result.text];
    // One append is the commit: financial mutation and deduplication are inseparable.
    sheet.getRange(sheet.getLastRow()+1,1,1,HEADERS.length).setValues([record]);
    sheet.getRange(sheet.getLastRow(),2).setNumberFormat(TIME_FORMAT);
    SpreadsheetApp.flush();
    rows.push(record);
    syncExpenses_(book,rows);
    SpreadsheetApp.flush();
    return result.text;
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}
function safeCell_(value) { return /^[=+@-]/.test(value) ? "'" + value : value; }
function money_(cents) { return '$' + (cents / 100).toLocaleString('en-US', {maximumFractionDigits:2}); }
function cents_(text) {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(text)) throw new Error('金額請使用正數，最多兩位小數，不加逗號或 $。');
  var amount = Math.round(Number(text) * 100);
  if (amount <= 0) throw new Error('金額必須大於 0。');
  return amount;
}
function iso_(date) { return date.toISOString().slice(0,10); }
function date_(text) {
  var parsed = new Date(text + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || iso_(parsed) !== text) throw new Error('日期請使用有效的 YYYY-MM-DD。');
  return parsed;
}
function closing_(year, month, day) {
  return new Date(Date.UTC(year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())));
}
function cycle_(today, day) {
  var now = date_(today), y = now.getUTCFullYear(), m = now.getUTCMonth();
  var end = closing_(y,m,day);
  if (now > end) end = closing_(y,m+1,day);
  var previous = closing_(end.getUTCFullYear(),end.getUTCMonth()-1,day);
  previous.setUTCDate(previous.getUTCDate()+1);
  return {start:iso_(previous), end:iso_(end)};
}
function replay_(ops) {
  var state = {cards:Object.create(null), transactions:[]};
  ops.forEach(function(op) { apply_(state,op); });
  return state;
}
function apply_(state, op) {
  if (op.type === '新增卡片' || op.type === '修改卡片') state.cards[op.card] = {day:op.day, limit:op.limit};
  if (op.type === '消費') state.transactions.push(op);
  if (op.type === '撤銷') {
    var tx = state.transactions.find(function(t) { return t.id === op.target; });
    if (tx) tx.voided = true;
  }
}
function summary_(state,today) {
  var names = Object.keys(state.cards);
  if (!names.length) return '尚未設定卡片。\n傳送：新增卡片 玉山 23 3000';
  return names.map(function(name) {
    var card = state.cards[name], cycle = cycle_(today,card.day);
    var used = state.transactions.filter(function(t) { return !t.voided && t.card === name && t.date >= cycle.start && t.date <= cycle.end; }).reduce(function(sum,t) { return sum+t.cents; },0);
    return name+'（'+cycle.start+'～'+cycle.end+'）\n已刷 '+money_(used)+'／上限 '+money_(card.limit)+'\n'+(used > card.limit ? '⚠️ 已超過上限 '+money_(used-card.limit) : '剩餘 '+money_(card.limit-used));
  }).join('\n\n');
}
function normalizeMessage_(text) { return text.trim().replace(/\s+/g,' '); }
function matchesOriginal_(transaction, target) {
  if (transaction.originalText !== undefined) return normalizeMessage_(transaction.originalText) === target;
  // Older events never retained the original input: match stored fields conservatively.
  var parts = target.split(' '), date;
  if (parts.length >= 4 && /^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(parts[parts.length-1])) {
    date = parts.pop().replace(/-/g,'');
    if (date !== transaction.date.replace(/-/g,'')) return false;
  }
  if (parts.length < 3 || parts[0] !== transaction.card) return false;
  var amount = parts.pop();
  try { if (cents_(amount) !== transaction.cents) return false; } catch (err) { return false; }
  return parts.slice(1).join(' ') === normalizeMessage_(transaction.item);
}
function command_(state, text, today, id, sheetUrl) {
  try {
    var parts = text.trim().split(/\s+/), verb = parts[0], op, prefix;
    if (text.trim() === '說明' || text.trim() === 'help') return {text:HELP};
    if (text.trim() === '查詢') return {text:summary_(state,today)+(sheetUrl ? '\n\n────────────────\n記帳試算表\n'+sheetUrl : '')};
    if (verb === '新增卡片' || verb === '修改卡片') {
      if (parts.length !== 4) throw new Error('格式：'+verb+' 玉山 23 3000');
      var name = parts[1], day = Number(parts[2]);
      if (['查詢','說明','help','撤銷上一筆','新增卡片','修改卡片'].indexOf(name) !== -1) throw new Error('卡片名稱不可使用指令名稱。');
      if (!/^[\p{L}\p{N}_-]{1,20}$/u.test(name)) throw new Error('卡片名稱限 1～20 個中英文字、數字、底線或連字號。');
      if (!/^\d{1,2}$/.test(parts[2]) || day < 1 || day > 31) throw new Error('結帳日請輸入 1～31。');
      if (verb === '新增卡片' && state.cards[name]) throw new Error('卡片已存在，請使用「修改卡片」。');
      if (verb === '修改卡片' && !state.cards[name]) throw new Error('找不到這張卡，請先新增卡片。');
      if (verb === '新增卡片' && Object.keys(state.cards).length >= 30) throw new Error('最多可設定 30 張卡片。');
      op = {type:verb,card:name,day:day,limit:cents_(parts[3])};
      prefix = '✅ 已'+verb+'：'+name;
     } else if (text.trim() === '撤銷上一筆' || /^撤銷\s*[（(]/.test(text.trim())) {
      var target = null;
      if (text.trim() !== '撤銷上一筆') {
        var match = text.trim().match(/^撤銷\s*(?:\(([\s\S]+)\)|（([\s\S]+)）)$/);
        if (!match || !(match[1] || match[2]).trim()) throw new Error('請把原始訊息放進括號，例如：撤銷(玉山 蝦皮 599)');
        target = normalizeMessage_(match[1] || match[2]);
      }
      var matches = state.transactions.slice().reverse().filter(function(t) {
        return !t.voided && (target === null || matchesOriginal_(t,target));
      });
      var last = matches[0];
      if (!last) throw new Error(target === null ? '沒有可撤銷的消費紀錄。' : '找不到尚未撤銷的相符紀錄。請貼上原始記帳訊息，包含當時填寫的日期。');
      op = {type:'撤銷',target:last.id,card:last.card};
      prefix = '↩️ 已撤銷：'+last.card+'｜'+last.item+'｜'+money_(last.cents)+'\n📅 刷卡日期：'+last.date;
      if (target !== null && matches.length > 1) prefix += '\n💡 找到 '+matches.length+' 筆相符紀錄，本次撤銷最近一筆。';
    } else {
      if (!state.cards[verb]) throw new Error('找不到卡片或指令。\n\n'+HELP);
      if (parts.length < 3) throw new Error('格式：玉山 蝦皮 599 [YYYYMMDD]');
      var date = today;
      var tail = parts[parts.length-1];
      if (/^\d{4}[-/]/.test(tail)) throw new Error('刷卡日請使用 YYYYMMDD，例如 20260920。');
      if (parts.length >= 4 && /^\d{8}$/.test(tail)) {
        parts.pop();
        date = tail.slice(0,4)+'-'+tail.slice(4,6)+'-'+tail.slice(6,8);
        try { date_(date); } catch (err) { throw new Error('刷卡日無效，請使用 YYYYMMDD，例如 20260920。'); }
      }
      date_(date);
      if (date > today) throw new Error('消費日期不能晚於今天。');
      var cents = cents_(parts.pop()), item = parts.slice(1).join(' ');
      if (!item || item.length > 100) throw new Error('項目請填 1～100 個字。');
      op = {type:'消費',id:id,card:verb,item:item,cents:cents,date:date,originalText:text.trim()};
      prefix = '✅ 已記帳：'+verb+'｜'+item+'｜'+money_(cents)+'\n消費日期：'+date;
      var billing = cycle_(date,state.cards[verb].day);
      prefix += '\n所屬結帳日：'+billing.end;
    }
    apply_(state,op);
    return {op:op,text:prefix+'\n\n'+summary_(state,today)};
  } catch (err) { return {text:'❌ '+err.message}; }
}
