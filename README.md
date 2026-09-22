# LINE 信用卡預算記帳

使用 LINE 訊息記錄信用卡消費，以 Google Apps Script（GAS）處理指令、Google 試算表儲存資料。適合個人手動記帳，不串接銀行；刷卡上限是自己設定的每期預算。

## 功能

- 新增／修改多張卡片，各自依結帳日計算本期用量。
- 記帳、補登日期、查詢、撤銷上一筆或指定消費。
- 每次記帳回覆全部卡片的用量及超額提醒。
- 查詢附上自己的記帳試算表連結。
- 台灣時間，消費明細、操作日誌、系統診斷分開保存。

## 專案檔案

~~~text
gas/Code.gs           貼入 Apps Script 的主程式
gas/appsscript.json   Apps Script 權限與時區設定
tests/budget.test.mjs 本機測試（不需貼入 GAS）
package.json         本機測試指令
.gitignore           排除本機設定、密鑰檔與執行產物
README.md            使用、部署與排錯教學
~~~

## 使用方式

```text
新增卡片 玉山 23 3000
新增卡片 國泰 10 5000
玉山 蝦皮 599
玉山 午餐 外送 180
玉山 蝦皮 599 20260920
查詢
撤銷上一筆
撤銷(玉山 蝦皮 599)
撤銷(玉山 蝦皮 599 20260920)
修改卡片 玉山 23 4000
說明
```

- 金額不加 `$` 或逗號，可有兩位小數，必須大於零。幣別預設新台幣。
- 卡片名稱不可有空格；項目可有空格。最多 30 張卡片。
- 每次成功記帳都回覆全部卡片「各自目前週期」的已刷、上限、剩餘或超額金額。嚴格大於上限才顯示超額。
- 台灣時間，結帳日包含在本期。例如 23 日結帳，8/24～9/23 為一期。
- 29～31 日遇短月份取月底。無須排程清零，歷史消費永久保留。
- 指定刷卡日使用 YYYYMMDD（例如 20260920），省略代表今天；補登會計入歷史週期，回覆仍顯示目前各卡週期。八位數字放在至少四段輸入的最後會被當成日期；如項目有空格又要輸入八位數金額，請明確加上刷卡日，避免歧義。
- 撤銷上一筆指最後「記錄」且未撤銷的消費（不限卡片），不刪除原始列。設定操作不會被撤銷。
- 指定撤銷用 `撤銷(原始記帳訊息)`，也支援全形括號。忽略頭尾和重複空白，其餘文字依原始訊息比對；原本有填日期就要包含日期。同樣訊息重複記帳時，每次只撤銷最近一筆尚未撤銷的符合紀錄，回覆會提示符合筆數。無相符紀錄就不更動資料。
- 新版保存原始消費訊息於操作資料。舊紀錄沒有原始訊息，會依卡別、項目、金額及可選日期比對；舊版 YYYY-MM-DD 僅在撤銷舊紀錄時可用。舊紀錄省略日期比對可能符合不同日期的消費，建議加上日期縮小範圍。
- 修改結帳日會立即用新的日期規則重新統計；此版本不保存歷史帳單快照。

## 部署步驟

### 1. 準備 LINE 官方帳號

建立一般 LINE 官方帳號，在 LINE Official Account Manager「設定 → Messaging API」啟用功能，再到 LINE Developers Console 選擇該 channel。個人可以使用，不需要商家認證。

取得以下兩個值：

- **Channel access token**：Messaging API 頁面的長期 token，不是 Channel secret。
- **Your user ID**：Basic settings 的 U 開頭身分 ID，不是數字 Channel ID，也不是加好友用的 LINE ID。

將官方帳號加入好友，關閉內建自動回應訊息，避免重複回覆。

### 2. 建立試算表與 GAS

1. 建立私人 Google 試算表，記下網址 /spreadsheets/d/ 後的試算表 ID。
2. 選「擴充功能 → Apps Script」，把 [gas/Code.gs](gas/Code.gs) 完整貼入 Code.gs。
3. 開啟「專案設定 → 在編輯器中顯示 appsscript.json 資訊清單檔案」，把 [gas/appsscript.json](gas/appsscript.json) 貼入該檔案。
4. 在「專案設定 → 指令碼屬性」新增：

| 屬性 | 必填 | 說明 |
|---|---|---|
| SPREADSHEET_ID | 是 | 自己的試算表 ID |
| WEBHOOK_SECRET | 是 | 自行產生的長隨機密鑰，建議 32 bytes 隨機值的十六進位字串 |
| ALLOWED_USER_ID | 是 | 本人的 LINE user ID |
| LINE_CHANNEL_ACCESS_TOKEN | 是 | 此機器人的長期 access token |
| SPREADSHEET_URL | 否 | 查詢時附上的 HTTPS 連結，可填自己的短網址；未填則由試算表 ID 自動產生 |

密碼管理器或以下本機指令可產生密鑰：

~~~sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
~~~

所有實際 token、密鑰、ID 和私人連結都留在 GAS 指令碼屬性，不需填入專案原始碼或提交到 GitHub。

### 3. 完成 Google 授權

1. 儲存程式，在編輯器上方的函式下拉選單選 **setup**，按「執行」。
2. 出現 Google 授權視窗時，選擇要執行此專案的帳號，並確認勾選本專案要求的 **Google 試算表存取**與**連接外部服務**權限。
3. 選 **diagnoseConnection** 再執行一次。它會檢查 access token 和對外連線，不會發送 LINE 訊息。
4. 在試算表的「系統診斷」確認最新一列顯示連線成功。

**只按繼續、卻沒有勾選授權視窗裡的權限，也可能導致後續執行失敗。** 能寫入試算表不代表已取得對外呼叫 LINE 的權限。

### 4. 部署並連接 LINE

1. GAS「部署 → 新增部署作業 → 網頁應用程式」。執行身分選 **自己**，存取權選 **所有人**。
2. 複製以 /exec 結尾的網址，在 LINE Messaging API 的 Webhook URL 填入：

~~~text
https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?key=YOUR_WEBHOOK_SECRET
~~~

3. key 的值必須與 WEBHOOK_SECRET 相同。不加 /webhook，不使用 /dev 或 googleusercontent.com 的臨時網址。
4. 按 Verify，再開啟 Use webhook。可以啟用 Webhook redelivery，但不應依賴它保證補送。
5. 用 ALLOWED_USER_ID 對應的帳號**私訊** bot，傳送「說明」。

Verify 的空事件不測試記帳或 LINE 回覆。首次使用可用一張未使用的卡名依序測試：

~~~text
新增卡片 測試卡 23 3000
測試卡 測試一 2600
測試卡 測試二 599
查詢
撤銷上一筆
撤銷上一筆
~~~

第三則應顯示已刷 $3,199、超過 $199；撤銷兩筆後回到 $0。

## 授權漏勾或需要重新授權

若出現以下錯誤，代表 GAS 尚未取得對外連線權限，請求還沒有送到 LINE：

~~~text
You do not have permission to call UrlFetchApp.fetch.
Required permissions: https://www.googleapis.com/auth/script.external_request
~~~

1. 確認線上 appsscript.json 與本專案相同，oauthScopes 包含 spreadsheets 與 script.external_request，儲存並重新整理編輯器。
2. 在編輯器函式選單選 **resetAuthorization**，執行一次。此函式已保留在 Code.gs：

~~~javascript
function resetAuthorization() {
  ScriptApp.invalidateAuth();
}
~~~

3. 再選 **diagnoseConnection** 執行，重新完成 Google 授權，確認勾選試算表及連接外部服務權限。
4. 確認「系統診斷」最新一列顯示連線成功。
5. 「部署 → 管理部署作業 → 選原部署 → 編輯 → 新版本 → 部署」，再從 LINE 傳「說明」。

resetAuthorization 只撤銷目前使用者對此專案的授權，不會刪除記帳資料；重新授權完成前，bot 可能暫時無法工作。不要放進 webhook 或排程，也不需每次部署都執行。

如果下拉選單沒有這個函式，先確認已完整貼入最新版 Code.gs、儲存並重新整理。**不要在編輯器直接執行 doPost**：它需要 LINE 傳入的事件和網址 key，直接執行會缺少必要資料。

## 更新現有部署

更新 Code.gs；若 manifest 有變動也更新 appsscript.json 並授權。**只儲存程式不會更新 LINE 使用的線上版本。** 接著依實際操作選擇以下流程：

| GAS 的操作方式 | 部署網址 | 是否需要修改 LINE Webhook URL |
|---|---|---|
| 新增部署作業 | 產生新網址 | **需要，每次新增部署都要更新** |
| 管理部署作業 → 編輯原部署 → 新版本 → 部署 | 沿用原網址 | 不需要，前提是 LINE 原本就使用這個部署 |

### 方式 A：新增部署作業

1. GAS「部署 → 新增部署作業 → 網頁應用程式」，執行身分選自己，存取權選所有人。
2. 複製這次產生的新 `/exec` 網址。
3. 回到 **LINE Developers Console → 對應的 Messaging API channel → Messaging API → Webhook settings**，編輯 Webhook URL：

   ```text
   新的GAS部署網址/exec?key=你的WEBHOOK_SECRET
   ```

4. 儲存，按 Verify，確認 Use webhook 已開啟。
5. 從 LINE 重新傳一則「說明」，確認回覆是新版。

**如果新增部署後沒有更新 LINE Webhook URL，LINE 仍會呼叫舊網址，不會自行切換到新版；等待也不會讓它自動更新。**

### 方式 B：更新原部署（建議日常更新使用）

1. GAS「部署 → 管理部署作業」，選擇 **LINE 目前 Webhook URL 對應的部署**。
2. 按編輯（鉛筆），版本選「新版本」，按部署。
3. 確認部署網址與 LINE 設定的網址相同；原有的 `?key=...` 保持不變。
4. 從 LINE 重新傳一則「說明」驗證。聊天中已收到的舊訊息不會改變。

從早期版本升級、或要轉換舊時間與分頁時，部署前先執行 setup。已完成遷移的一般指令／說明更新不必重跑 setup。若要保留自訂查詢短網址，請在 SPREADSHEET_URL 設定它。

## 試算表資料與維護

- **記帳紀錄**：只有消費明細，欄位為事件 ID、記錄時間、卡別、金額、項目、消費日期、狀態。撤銷後保留消費列並標示「已撤銷」；自行加總時只計算「有效」列。
- **操作紀錄**：完整事件日誌，包含消費、設定、查詢、說明、撤銷和錯誤指令。保留消費事件作為防重複記帳與重建明細的依據。隱藏 K、L 欄是機器使用的 JSON 與回覆。
- **系統診斷**：連線檢查結果與執行錯誤。

記錄時間使用真正的日期值，以 Asia/Taipei 時區及 yyyy-mm-dd hh:mm:ss 格式顯示，例如原本 2026-09-21T09:15:07.669Z 會顯示 2026-09-21 17:15:07。消費日期仍是用來歸屬結帳週期的日期。

升級時先貼上新版 Code.gs、儲存，執行 setup，再依上方「更新現有部署」完成部署；若選新增部署作業，還須更新 LINE Webhook URL。setup 會把舊的混合「記帳紀錄」改名為「操作紀錄」，保留所有原始事件，再建立只有消費的新「記帳紀錄」。既有 ISO 時間也會轉成日期值。可重複執行 setup，不會重複匯入資料。升級期間暫停傳送指令，完成部署與 LINE 設定後再使用。

不要手動刪除或修改操作紀錄、也不要排序操作紀錄；事件順序用於重建狀態。記帳紀錄是自動生成的明細，手動修改會被下次同步覆蓋；若要自行整理分析，請複製到其他分頁。

系統先在鎖定期間把操作與事件 ID 一次寫入操作紀錄，再同步消費明細。若中途同步失敗，重送同事件或下一次指令會從操作紀錄重建，不會再次扣款。每次仍會讀取完整事件表，適合個人小量使用。

LINE 回覆與試算表寫入不是同一筆交易，可能已記帳但回覆失敗；此時先傳「查詢」，不要重新輸入同筆消費。Reply token 過期或已使用時無法保證再次回覆，此版本不另外 Push 補發。

更新 GAS 後要「部署 → 管理部署作業 → 編輯 → 新版本 → 部署」，只有儲存不會更新線上版本。

## 排錯

| 現象 | 檢查方式 |
|---|---|
| 記帳成功，但 LINE 沒回覆 | 看「系統診斷」，先傳查詢確認，不要重傳同筆消費 |
| Google 授權不足 | 依上面的重新授權流程，確認沒有漏勾權限 |
| LINE HTTP 401 | access token 無效、失效或誤填 Channel secret |
| LINE HTTP 400 | reply token 可能過期、已使用或與 channel 不符 |
| 沒有寫入，也沒有回覆 | 檢查 Use webhook、網址 key、本人 user ID、部署版本；群組與非文字事件會被略過 |
| Verify 302、登入頁或非 200 | 確認 /exec、所有人存取權與部署版本；Workspace 管理員可能限制匿名 Web App |
| 新增部署後還在回覆舊說明 | 回 LINE Developers 更新為新部署的 Webhook URL，保留 `?key=...`，儲存後重新傳「說明」 |
| 更新原部署後還在回覆舊說明 | 確認更新的是 LINE 正在使用的部署，且版本選了「新版本」，再重新傳「說明」 |

看不到 webhook 執行 log 時，可直接看「系統診斷」分頁，或在編輯器執行 diagnoseConnection。若試算表本身無法存取，診斷分頁也可能無法寫入。

## 限制與資料保護

此純 GAS 版本不驗證 LINE 的 x-line-signature，改用網址密鑰與本人 user ID 限制；**這不等同 LINE 簽章驗證**。知道完整 webhook URL 的人可能偽造請求，勿公開帶 key 的網址，外洩時更換密鑰。試算表本身不必公開。

GAS 對 HTTP 狀態碼的控制有限，執行失敗不保證能觸發 LINE 重送；回覆亦受 reply token 時效限制。程式使用 HtmlOutput 避免 ContentService 的內容轉址，但部署後仍必須實測。

目前使用 Reply API，不主動推播。依 LINE 現行規則，Reply API 不計入方案訊息則數，仍有平台技術配額。

## 本機測試

需要 Node.js 22 或以上，不需安裝相依套件：

~~~sh
node --test tests/budget.test.mjs
~~~

也可使用 npm test。測試涵蓋週期、金額、撤銷、資料遷移、重送去重、驗證與錯誤處理，使用 GAS／LINE 模擬介面；無法代替部署後的私訊驗收。

## 官方參考

- [LINE Messaging API 建立流程](https://developers.line.biz/en/docs/messaging-api/getting-started/)
- [LINE 訊息計費](https://developers.line.biz/en/docs/messaging-api/pricing/)
- [GAS Web Apps](https://developers.google.com/apps-script/guides/web)
- [Google 授權說明](https://developers.google.com/apps-script/guides/services/authorization)
- [ScriptApp.invalidateAuth](https://developers.google.com/apps-script/reference/script/script-app#invalidateAuth())
