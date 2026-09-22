import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code = readFileSync(new URL('../gas/Code.gs', import.meta.url),'utf8');
function core(extra={}) { const ctx = vm.createContext({console,...extra}); vm.runInContext(code,ctx); return ctx; }
test('closing day, next day, leap year, short month, year boundary', () => {
  const c=core();
  for (const [date,day,start,end] of [
    ['2026-09-23',23,'2026-08-24','2026-09-23'],
    ['2026-09-24',23,'2026-09-24','2026-10-23'],
    ['2024-02-29',31,'2024-02-01','2024-02-29'],
    ['2026-03-01',31,'2026-03-01','2026-03-31'],
    ['2026-01-01',23,'2025-12-24','2026-01-23']]) {
    assert.equal(c.cycle_(date,day).start,start); assert.equal(c.cycle_(date,day).end,end);
  }
});
test('record, exceed, all cards, undo, cents and backdated spending', () => {
  const c=core(), s=c.replay_([]);
  const run=(text,id='x')=>c.command_(s,text,'2026-09-21',id);
  run('新增卡片 玉山 23 3000'); run('新增卡片 國泰 10 5000');
  run('玉山 早餐 2600','1');
  assert.match(run('玉山 蝦皮 599','2').text,/已超過上限 \$199/);
  assert.match(run('查詢').text,/國泰/);
  assert.match(run('撤銷上一筆','3').text,/剩餘 \$400/);
  run('玉山 舊消費 900 20260801','4');
  assert.match(run('查詢').text,/已刷 \$2,600/);
  run('玉山 小額 0.10','5'); run('玉山 小額 0.20','6');
  assert.match(run('查詢').text,/2,600.3/);
  assert.equal(s.transactions.length,5);
});
test('invalid amounts, dates, names, unknown cards leave no mutation', () => {
  const c=core(),s=c.replay_([]);
  c.command_(s,'新增卡片 玉山 23 3000','2026-09-21','a');
  for (const text of ['玉山 蝦皮 -1','玉山 蝦皮 0','玉山 蝦皮 1.001','玉山 蝦皮 1 20260230','玉山 蝦皮 1 20260922','新增卡片 玉山 23 1','新增卡片 新卡 32 1','別卡 蝦皮 1']) {
    assert.match(c.command_(s,text,'2026-09-21','b').text,/^❌/);
  }
  assert.equal(s.transactions.length,0);
  assert.equal(c.safeCell_('=IMPORTXML(...)'),"'=IMPORTXML(...)");
});
test('replaying saved operations preserves undo and latest card settings',()=>{
  const c=core(), s=c.replay_([]), ops=[];
  for (const [i,text] of ['新增卡片 玉山 23 3000','玉山 蝦皮 599','撤銷上一筆','修改卡片 玉山 10 4000'].entries()) {
    ops.push(c.command_(s,text,'2026-09-21',String(i)).op);
  }
  const restored=c.replay_(JSON.parse(JSON.stringify(ops)));
  assert.match(c.summary_(restored,'2026-09-21'),/已刷 \$0／上限 \$4,000/);
  assert.match(c.summary_(restored,'2026-09-21'),/2026-09-11～2026-10-10/);
});

function memoryBook() {
  const sheets={};
  const book={getSheetByName:name=>sheets[name] || null,setSpreadsheetTimeZone:zone=>book.zone=zone,insertSheet:name=>{
    const data=[],formats=[];
    const sheet={data,formats,getLastRow:()=>data.length,appendRow:row=>data.push([...row]),setFrozenRows(){},hideColumns(){},
      setName:next=>{delete sheets[name];sheets[next]=sheet;name=next;},
      getRange:(r,col,n=1,width=1)=>{
        const range={getValue:()=>data[r-1]?.[col-1],getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:width},(_,j)=>data[r-1+i]?.[col-1+j]??'')),
          setValues:values=>{values.forEach((row,i)=>{data[r-1+i]??=[];row.forEach((v,j)=>data[r-1+i][col-1+j]=v);});return range;},
          setNumberFormat:f=>{formats.push(f);return range;},setFontWeight:()=>range,setBackground:()=>range,
          clearContent:()=>{for(let i=0;i<n;i++)for(let j=0;j<width;j++)if(data[r-1+i])data[r-1+i][col-1+j]='';}};
        return range;
      }};
    sheets[name]=sheet; return sheet;
  }};
  return book;
}
function harness() {
  const replies=[];
  const book=memoryBook();
  let status=200;
  
  const props={SPREADSHEET_ID:'sheet',WEBHOOK_SECRET:'secret',ALLOWED_USER_ID:'owner',LINE_CHANNEL_ACCESS_TOKEN:'token'};
  const c=core({PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]})},
    SpreadsheetApp:{openById:()=>book,flush(){}},
    LockService:{getScriptLock:()=>({waitLock(){},hasLock:()=>true,releaseLock(){}})},
    Utilities:{formatDate:()=> '2026-09-21'}, HtmlService:{createHtmlOutput:s=>s},
    UrlFetchApp:{fetch:(url,options)=>{replies.push({url,options,body:options.payload ? JSON.parse(options.payload) : null});return {getResponseCode:()=>status};}}});
  c.setup();
  const event=(id,text)=>({webhookEventId:id,replyToken:'reply-'+id,timestamp:Date.now(),type:'message',source:{type:'user',userId:'owner'},message:{type:'text',text}});
  const post=(events,key='secret')=>c.doPost({parameter:{key},postData:{contents:JSON.stringify({events})}});
  return {c,book,get rows(){return book.getSheetByName('操作紀錄').data.slice(1);},replies,props,event,post,setStatus:s=>status=s};
}
test('direct LINE webhook records once and replies with all cards',()=>{
  const h=harness();
  const setup=h.event('a','新增卡片 玉山 23 3000');
  assert.equal(h.post([setup]),'OK');
  assert.equal(h.post([setup]),'OK'); assert.equal(h.rows.length,1);
  const purchase=h.event('b','玉山 蝦皮 599');
  assert.equal(h.post([purchase]),'OK'); assert.equal(h.post([purchase]),'OK');
  assert.equal(h.rows.length,2);
  assert.match(h.replies.at(-1).body.messages[0].text,/599/);
  assert.equal(h.replies.at(-1).options.headers.Authorization,'Bearer token');
  assert.equal(h.replies.at(-1).body.replyToken,'reply-b');
});
test('empty verification events, invalid secret, other users, groups and non-text',()=>{
  const h=harness();
  assert.equal(h.post([]),'OK');
  const e=h.event('a','查詢');
  assert.equal(h.post([e],'wrong'),'Unauthorized');
  assert.equal(h.post([e],''),'Unauthorized');
  assert.equal(h.post([{...e,source:{type:'user',userId:'other'}},{...e,source:{type:'group',userId:'owner'}},{type:'follow'},{...e,message:{type:'image'}},null]),'OK');
  assert.equal(h.rows.length,0); assert.equal(h.replies.length,0);
  delete h.props.LINE_CHANNEL_ACCESS_TOKEN;
  assert.throws(()=>h.post([e]),/Missing script properties/);
});
test('multiple events are processed in sequence',()=>{
  const h=harness();
  h.post([h.event('a','新增卡片 玉山 23 3000'),h.event('b','玉山 蝦皮 3100')]);
  assert.equal(h.rows.length,2); assert.equal(h.replies.length,2);
  assert.match(h.replies[1].body.messages[0].text,/已超過上限/);
});
test('reply failure preserves commit and redelivery does not duplicate spending',()=>{
  const h=harness();
  h.post([h.event('a','新增卡片 玉山 23 3000')]);
  h.setStatus(500);
  const e=h.event('b','玉山 蝦皮 599');
  assert.throws(()=>h.post([e]),/events failed/); assert.equal(h.rows.length,2);
  h.setStatus(200); assert.equal(h.post([e]),'OK'); assert.equal(h.rows.length,2);
});
test('malformed envelope is rejected',()=>{
  const h=harness();
  assert.throws(()=>h.post({}),/Invalid events/);
  assert.throws(()=>h.c.doPost({parameter:{key:'secret'},postData:{contents:'bad json'}}));
  assert.equal(h.rows.length,0);
});

test('diagnostics persist reply failure and classify authorization without leaking secrets',()=>{
  const h=harness(), diagnostics=[];
  h.c.writeDiagnostic_=(stage,detail)=>diagnostics.push({stage,detail});
  h.setStatus(401);
  assert.throws(()=>h.post([h.event('a','說明')]),/events failed/);
  assert.equal(diagnostics[0].stage,'回覆 LINE');
  assert.match(diagnostics[0].detail,/401/);
  assert.match(h.c.diagnosticMessage_(new Error('Permission required script.external_request')),/Google 授權不足/);
  assert.ok(!h.c.diagnosticMessage_(new Error('secret-value')).includes('secret-value'));
  h.setStatus(200);
  assert.match(h.c.diagnoseConnection(),/連線成功/);
  assert.equal(diagnostics[1].stage,'編輯器連線檢查');
});

test('original diagnostic preserves error detail and redacts configured secrets',()=>{
  const c=core({PropertiesService:{getScriptProperties:()=>({getProperties:()=>({LINE_CHANNEL_ACCESS_TOKEN:'private-token',WEBHOOK_SECRET:'private-key'})})}});
  const message=c.redactDiagnostic_(new Error('Required permission: script.external_request private-token https://example.com?key=private-key'));
  assert.match(message,/Required permission: script.external_request/);
  assert.ok(!message.includes('private-token')); assert.ok(!message.includes('private-key'));
});

test('expense sheet excludes commands and marks undo; timestamps are native dates',()=>{
  const h=harness();
  const e=h.event('a','新增卡片 玉山 23 3000'); e.timestamp=Date.parse('2026-09-21T09:15:07.669Z');
  h.post([e,h.event('b','玉山 蝦皮 599'),h.event('c','說明'),h.event('d','查詢')]);
  const sheet=h.book.getSheetByName('記帳紀錄');
  assert.equal(sheet.data.length,2); assert.equal(sheet.data[1][2],'玉山');
  assert.equal(sheet.data[1][6],'有效');
  assert.equal(h.rows[0][1].toISOString(),'2026-09-21T09:15:07.669Z');
  assert.equal(h.book.zone,'Asia/Taipei');
  assert.ok(sheet.formats.includes('yyyy-mm-dd hh:mm:ss'));
  h.post([h.event('e','撤銷上一筆')]);
  assert.equal(sheet.data.length,2);assert.equal(sheet.data[1][6],'已撤銷');
});
test('setup migrates legacy ledger without losing events and is repeatable',()=>{
  const h=harness();
  h.post([h.event('a','新增卡片 玉山 23 3000'),h.event('b','玉山 蝦皮 599'),h.event('c','撤銷上一筆')]);
  const original=h.rows.map(row=>{const copy=[...row];copy[1]=copy[1].toISOString();return copy;});
  const legacy=memoryBook();const old=legacy.insertSheet('記帳紀錄');
  old.appendRow(Array.from(h.c.HEADERS)); original.forEach(row=>old.appendRow(row));
  h.c.SpreadsheetApp.openById=()=>legacy;
  h.c.setup();h.c.setup();
  assert.equal(legacy.getSheetByName('操作紀錄'),old);
  assert.equal(old.data.length,4);
  assert.equal(typeof old.data[1][1].getTime,'function');
  assert.equal(legacy.getSheetByName('記帳紀錄').data.length,2);
  assert.equal(legacy.getSheetByName('記帳紀錄').data[1][6],'已撤銷');
  assert.equal(h.post([h.event('b','玉山 蝦皮 599')]),'OK');
  assert.equal(old.data.length,4);
});
test('redelivery repairs expense projection after write failure without double spending',()=>{
  const h=harness();h.post([h.event('a','新增卡片 玉山 23 3000')]);
  const original=h.c.syncExpenses_;h.c.syncExpenses_=()=>{throw new Error('temporary failure');};
  const e=h.event('b','玉山 蝦皮 599');
  assert.throws(()=>h.post([e]),/events failed/);assert.equal(h.rows.length,2);
  h.c.syncExpenses_=original;h.post([e]);
  assert.equal(h.rows.length,2);assert.equal(h.book.getSheetByName('記帳紀錄').data.length,2);
});

test('compact dates validate leap day and reject old date syntax',()=>{
  const c=core(),s=c.replay_([]);c.command_(s,'新增卡片 玉山 23 3000','2026-09-21','a');
  assert.equal(c.command_(s,'玉山 蝦皮 599 20260920','2026-09-21','b').op.date,'2026-09-20');
  assert.equal(c.command_(s,'玉山 蝦皮 599 20240229','2026-09-21','c').op.date,'2024-02-29');
  for(const date of ['20260229','20261301','20260922','2026-09-20']) assert.match(c.command_(s,'玉山 蝦皮 599 '+date,'2026-09-21','d').text,/^❌/);
});
test('targeted undo picks newest active match, preserves other purchases and matches original date',()=>{
  const c=core(),s=c.replay_([]); const run=(text,id)=>c.command_(s,text,'2026-09-21',id);
  run('新增卡片 玉山 23 3000','a');run('玉山 蝦皮 599','b');run('玉山 蝦皮 599','c');run('玉山 午餐 99','d');
  assert.equal(run('撤銷(玉山 蝦皮 599)','e').op.target,'c');
  assert.equal(run('撤銷（玉山   蝦皮 599）','f').op.target,'b');
  assert.match(run('撤銷(玉山 蝦皮 599)','g').text,/^❌/);
  assert.equal(s.transactions.find(t=>t.id==='d').voided,undefined);
  run('玉山 蝦皮 599 20260920','h');
  assert.match(run('撤銷(玉山 蝦皮 599)','i').text,/^❌/);
  assert.equal(run('撤銷(玉山 蝦皮 599 20260920)','j').op.target,'h');
  assert.match(run('撤銷()','k').text,/^❌/);
});
test('targeted undo survives replay and marks expense view; legacy events match stored fields',()=>{
  const h=harness();h.post([h.event('a','新增卡片 玉山 23 3000'),h.event('b','玉山 蝦皮 599 20260920'),h.event('c','玉山 午餐 99')]);
  const undo=h.event('d','撤銷(玉山 蝦皮 599 20260920)');h.post([undo]);h.post([undo]);
  assert.equal(h.rows.length,4);
  const data=h.book.getSheetByName('記帳紀錄').data;
  assert.equal(data[1][6],'已撤銷');assert.equal(data[2][6],'有效');
  const tx={type:'消費',id:'old',card:'玉山',item:'蝦皮',cents:59900,date:'2026-09-20'};
  assert.equal(h.c.matchesOriginal_(tx,'玉山 蝦皮 599'),true);
  assert.equal(h.c.matchesOriginal_(tx,'玉山 蝦皮 599 20260920'),true);
  assert.equal(h.c.matchesOriginal_(tx,'玉山 蝦皮 599 2026-09-20'),true);
  assert.equal(h.c.matchesOriginal_(tx,'玉山 蝦皮 599 20260919'),false);
});

test('query links use configured spreadsheet or generated URL, only in query replies',()=>{
  const h=harness();h.post([h.event('q1','查詢')]);
  assert.ok(h.replies.at(-1).body.messages[0].text.includes('https://docs.google.com/spreadsheets/d/sheet/edit'));
  h.props.SPREADSHEET_URL='https://example.com/my-ledger';
  h.post([h.event('q2','查詢')]);assert.ok(h.replies.at(-1).body.messages[0].text.includes(h.props.SPREADSHEET_URL));
  h.post([h.event('a','新增卡片 玉山 23 3000'),h.event('b','玉山 蝦皮 599')]);
  assert.ok(!h.replies.at(-1).body.messages[0].text.includes(h.props.SPREADSHEET_URL));
});
test('resetAuthorization invalidates authorization only',()=>{
  let invalidations=0;const c=core({ScriptApp:{invalidateAuth:()=>invalidations++}});
  c.resetAuthorization();assert.equal(invalidations,1);
});
