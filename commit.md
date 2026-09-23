# Commit 格式

**一個 commit 只處理一件可以獨立說明、驗證與回退的事。** TREM-Lite 同時包含
React/TypeScript 共用核心、Web shell、Tauri/Rust 桌面程式與 legacy 參考實作；提交前不只要
確認能建置，也要確認受影響平台的實際行為。

這份格式自文件加入後適用於新 commit，不回頭改寫既有歷史。

> 訊息格式由 `tool/check/commits.sh` 機械強制執行 —— 那支腳本才是規格，本文件是
> 它的說明。`.githooks/commit-msg` 在寫訊息時就擋，`.githooks/pre-push` 在推之前
> 再走一次整個 range，CI 的 `commits` job 是最後一道。啟用 hook：
>
> ```sh
> git config core.hooksPath .githooks
> ```
>
> 閘門只能判斷格式。提交邊界、驗證矩陣與「這個描述是否誠實」仍然靠作者與 review。

---

## 提交前先看完整工作樹

```sh
git branch --show-current
git status --short
git diff --stat
git diff --cached --stat
```

提交前必須分清楚：

- staged、unstaged、untracked 各有哪些檔案。
- 哪些變更是這次工作，哪些是使用者或其他工作留下的變更。
- 新增檔案是否已 stage；只看 `git diff` 會漏掉 untracked 檔案。
- 是否誤放入 `dist/`、`target/`、`node_modules/`、log、截圖、錄影或臨時探針。
- 是否在 `main`；日常修改應在功能分支進行。

**不要為了整理這次 commit 丟棄不屬於自己的工作樹變更。** 混合工作樹要逐檔或逐 hunk
stage，必要時先建立可恢復的備份。

---

## 訊息格式

```text
<type>(<scope>): <英文摘要>

<Category>(zh-Hant): <繁體中文更新日誌條目>
<Category>(en-US): <英文更新日誌條目>
```

範例：

```text
fix(speech): announce counties in intensity alerts

Fix(zh-Hant): 震度速報會念出最高震度地區的縣市名稱
Fix(en-US): intensity alerts now announce the counties at the maximum intensity
```

第一行給 `git log` 與開發者閱讀；分類條目描述使用者實際感受到的結果，由
`tool/release/notes.sh` 原文組成 GitHub 發佈說明，再由 `tool/release/discord.py` 轉成
Discord 公告。

純內部變更不需要硬寫更新日誌條目：

```text
test(replay): cover intensity overlay restoration
docs: define the commit format
ci: compile every desktop target
```

---

## 摘要行

```text
fix(replay): keep the alert frame visible during playback
└┬┘ └─┬──┘  └──────────────────┬─────────────────┘
 type  scope                  摘要
```

### type

| type | 用在 | 需要使用者更新日誌條目 |
|---|---|---|
| `feat` | 新增使用者可用的功能 | 是，使用 `New` |
| `fix` | 修正使用者遇得到的錯誤 | 是，使用 `Fix` |
| `perf` | 行為不變但更快或更省資源 | 是，使用 `Optimization` |
| `refactor` | 對外行為不變的結構調整 | 否 |
| `docs` | 只有文件 | 否 |
| `test` | 只有測試或測試工具 | 否 |
| `build` | 建置、相依套件、打包或版本 | 否；若改變使用者行為則例外 |
| `ci` | GitHub Actions 或檢查流程 | 否 |
| `style` | 只有格式，沒有語意或視覺變化 | 否 |
| `chore` | 其他維護工作 | 否 |
| `revert` | 回退既有 commit | 視被回退的使用者影響決定 |

判斷 type 看的是**行為是否被使用者感受到**，不是改到哪種檔案。修改 Rust 也可能是
`fix(audio)`，修改 CSS 也可能是 `feat(map)`。

### scope

scope 選填，使用小寫。常用範圍：

- 地震資料與顯示：`eew`、`rts`、`intensity`、`lpgm`、`report`、`replay`。
- 介面與地圖：`map`、`pip`、`settings`、`window`、`ui`。
- 輸出：`audio`、`speech`、`notify`。
- 平台與基礎設施：`core`、`desktop`、`web`、`tauri`、`release`、`deps`。

同一件行為合理地跨越多個模組時可以不寫 scope，不要為了填欄位把它歸到錯的區域。

### 英文摘要

- 使用英文與純 ASCII。
- 使用祈使句：`add`、`fix`、`keep`、`stop`、`show`。
- 說明完成的行為，不寫「update files」或「misc fixes」。
- 最多 72 個字元，結尾不加句號。
- 避免摘要用 `and` 串接兩件可獨立回退的工作。

---

## 使用者更新日誌條目

分類只有三種：

| 分類 | 用途 |
|---|---|
| `New` | 新功能 |
| `Optimization` | 效能或體驗最佳化 |
| `Fix` | 錯誤修正 |

使用者可見的 commit 至少要有一組 `zh-Hant` 與 `en-US`，而且兩個語言的條目數及順序
必須一致。

**這些條目會原文公開。** 推上 `main` 後大約 12 分鐘，快照發布，`zh-Hant` 條目會出現在
GitHub release 與 Discord 公告上；正式版在人工發布時公告。沒有任何條目的快照不公告。
條目寫的是使用者讀得懂的結果，不是給開發者看的實作筆記。

```text
perf(map): reduce terrain redraws while panning

Optimization(zh-Hant): 拖曳地形地圖時畫面更流暢
Optimization(en-US): panning the terrain map is now smoother
```

條目只寫使用者得到的結果：

```text
✗ Fix(zh-Hant): 重構 IntensityRelease listener 並共用 Set 去重 helper
✓ Fix(zh-Hant): 震度速報會念出最高震度地區且不會重複縣市名稱
```

一個 commit 可以有多個條目，但若需要跨分類或超過三項，應重新檢查是否其實混入了
多件工作。

---

## 平台 trailer

只影響特定執行環境時，在更新日誌條目前加入：

```text
fix(audio): keep alert playback outside the WebView

Platform: desktop

Fix(zh-Hant): 桌面版視窗擷取不再異常收進程式音效
Fix(en-US): desktop window capture no longer captures app sound unexpectedly
```

可用值：

- `web`：只影響瀏覽器版。
- `desktop`：影響所有 Tauri 桌面版。
- `macos`、`windows`、`linux`：只影響單一桌面作業系統。

Web 與 desktop 都受影響就不加。只改 Tauri，但三個桌面作業系統都受影響時使用
`desktop`，不要任選其中一個 OS。

trailer 的值由閘門驗證 —— 打錯會被擋下，而不是悄悄從 release note 消失。

**發佈說明的每一條都會標平台**，不只被收窄的那些：

| trailer | 標記 |
|---|---|
| 不加 | ![Web](.github/assets/web.svg) ![Windows](.github/assets/windows.svg) ![macOS](.github/assets/macos.svg) ![Linux](.github/assets/linux.svg) |
| `desktop` | ![Windows](.github/assets/windows.svg) ![macOS](.github/assets/macos.svg) ![Linux](.github/assets/linux.svg) |
| `web` | ![Web](.github/assets/web.svg) |
| `windows` / `macos` / `linux` | ![Windows](.github/assets/windows.svg) / ![macOS](.github/assets/macos.svg) / ![Linux](.github/assets/linux.svg) |

只標被收窄的那些，會讓其他每一行都變得有歧義 —— 讀的人分不出「全平台都有」和「沒人講」，而這是兩種不同的主張。

---

## 一個 commit 一件事

以下情況要停下來重新切分：

- 摘要列舉多件事或用 `and` 串接無關結果。
- 同時需要兩個 type 才能說清楚。
- 一半是功能，一半是無關文件或工具整理。
- 一個 commit 同時修正 replay、重畫設定頁與升級相依套件。
- 無法用一組明確步驟驗證整個 commit。

合理的跨層變更仍是一件事。例如「震度速報念出縣市」可能同時修改地區轉換 helper、
speech client 與測試，因為三者共同完成同一個使用者結果。

若已經 commit 才發現混在一起，可以保留工作內容後重新切分：

```sh
git reset --mixed HEAD~1
git add <第一組檔案>
git commit
git add <第二組檔案>
git commit
```

這會改寫尚未分享的本機歷史。已推送或多人共用的分支不能直接照做，應先確認協作狀態。

---

## 驗證矩陣

### 所有程式變更

先跑 CI 的平台無關 gate：

```sh
bun install
bun run typecheck
bun run build:web
```

`bun run lint` 目前帶有 `--fix`，會修改檔案；需要執行時必須在之後重新檢查 diff：

```sh
bun run lint
git diff --stat
```

### Rust／Tauri／桌面整合

修改 `apps/desktop/`、Tauri command、桌面 plugin、原生視窗或音效引擎時：

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
(cd apps/desktop && bun run tauri build --no-bundle)
```

CI 會在 macOS arm64/x64、Linux arm64/x64、Windows arm64/x64/ia32 編譯桌面程式。本機
單一平台通過只能證明本機 target；不要把它寫成所有平台已驗證。

### UI、地圖與 legacy 視覺還原

涉及 UI、地圖、overlay、動畫、字型、PiP 或版面時，build 通過不等於完成：

1. 背景啟動 legacy 與新版，使用相同視窗尺寸、地圖中心、縮放、資料與時間點。
2. 分別截圖，做疊圖或像素差異比較。
3. 檢查尺寸、位置、字級、色彩、透明度、圖層順序、裁切與縮放。
4. 再比較互動行為：點擊、拖曳、視窗切換、overlay 出現與消失時機。
5. 對合理差異留下原因；無法還原的地方要明確列為驗證限制。

不要為了讓比較通過而修改 `legacy/`。legacy 是基準；只有使用者明確要求更新基準時才改。

### Replay

重播修改至少覆蓋：

- 開始重播、切換另一筆事件與停止重播。
- RTS、EEW、震度速報、地震報告的時間軸是否一致。
- 黃色警示框、最大震度、地圖填色、測站與資訊面板是否在正確時機出現及清除。
- PiP 是否只在應出現時出現，主視窗與 PiP 狀態是否同步。
- 重播結束後是否恢復即時資料，且舊事件不會被當成新事件再次通知。
- 音效、TTS 與桌面通知是否符合重播規則，不重複、不漏播。

至少使用一筆會觸發目標行為的固定事件驗證，並記錄事件 ID／時間。只有一般事件跑完，
不能證明警示分支正確。

### 音效、TTS 與通知

這三條路徑分開驗證：

- MP3 音效：TypeScript 事件路由後，實際由 Rust `rodio` 引擎播放；驗證 queue、優先級、
  重疊、音量與設定開關。
- TTS：由 WebView 的 `speechSynthesis` 播放；驗證送入引擎的完整文字、縣市去重、語序、
  queue/cancel 與 `other-tts` 開關。
- 桌面通知：驗證權限、標題、內容、點擊聚焦與非 Tauri 環境不會拋錯。

聽到部分句子不能證明資料缺失；先記錄實際送入 TTS 的字串，再區分組字錯誤與系統語音
引擎問題。

### 資料、API 與重連

修改 RTS、SSE、WebSocket、HTTP fallback、時間同步或 endpoint 時，至少驗證：

- 正常回應、空資料、格式錯誤、逾時、斷線與重連。
- 即時模式與 replay 模式不會互相污染 cache。
- 桌面與 Web 的 transport 差異。
- API 資料中的 town code、震度鍵值與 timestamp 單位沒有被臆測或靜默轉換。

本機 mock 或錄製資料只證明該 fixture；不能宣稱目前 production endpoint 已驗證。

---

## 版本與 release

**版本不用手改。** `tool/release/version.sh` 從 git 狀態推導出所有值，
`--write` 會把它蓋進所有帶版本號的檔案：根目錄、`packages/core`、`apps/web`、
`apps/desktop` 的 `package.json`，加上 `apps/desktop/src-tauri/Cargo.toml` 與
`tauri.conf.json`。檔案裡當下那個值是佔位用的，release 流程會重新蓋。

命名照搬 DPIP（Minecraft 式），四個值刻意互不相關：

| 值 | 意義 | 發布版 | 快照版 |
|---|---|---|---|
| `label` | 人看的名字 | `26.2` | `26w39a` |
| `train` | 這個快照在往哪個發布版走 | `26.2` | `26.2` |
| `semver` | updater 拿來比大小的 | `26.2.0` | `26.2.0-26w39a` |
| `code` | 單調遞增的建置序號 | `426000312` | `426000313` |

- 發布版 tag 是 `v<yy>.<n>`（例：`v26.2`）。**`v` 前綴是唯一讓一個建置成為發布版
  的東西**，也是唯一需要人手動打的部分。支援 `v26.2.1` 這種修補形式。
- 快照 tag 是裸的 `<yy>w<week><letter>`（例：`26w39a`），沒有 `v`。週次是 ISO 週
  且不補前導零，字母數的是這週**已發布**的快照數。
- 週次用 **Asia/Taipei** 算。用 UTC 算的話，每個台北時間週一 00:00–08:00 都會落在
  前一個 ISO 週。
- `semver` 存在是因為 Tauri updater 是用 `tauri.conf.json` 的版本做 semver 比較，
  而 `26.2` 不是合法 semver。快照是其 train 的 **pre-release**，semver 排序會把它
  排在正式版**之前** —— 這正是正確的順序，也讓 updater 不會把快照推給已經在正式版
  的人。

```sh
tool/release/version.sh           # 印出 TREM_LABEL / TREM_TRAIN / TREM_SEMVER / …
tool/release/version.sh --json
tool/release/version.sh --write   # 蓋進上面那些檔案
```

`code` 是 `4 | yy | 今年的 commit 數`：`426000312` 讀作「第 4 代、2026 年、今年第
312 個 commit」。開頭那個世代數字是用來蓋過 app 已經發過的 `4.0.0` 以前的版本，讓
任何舊版都不會排在新版前面。

Release workflow 由 tag 觸發並建立 draft release。建立 tag 前必須確認 tag 名稱與應用版本
一致、CI 綠燈、桌面簽章／updater 所需 secrets 可用，以及 draft 的各平台產物名稱正確。
建立 GitHub draft 不等於已發布，也不等於 updater 已在真實安裝版驗證。

---

## 合併前

```sh
git fetch origin
git log --oneline --decorate --graph origin/main..HEAD
git log --oneline --merges origin/main..HEAD
git rev-list --count HEAD..origin/main
```

- 分支應建立在目前 `origin/main` 上，合併前處理落後狀態。
- 不要用 merge commit 把 `main` 拉進功能分支；保持可逐則 review 的線性歷史。
- 需要改寫已推送分支時使用 `git push --force-with-lease`，不得使用裸 `--force`。
- 推送前重新確認 staged／unstaged／untracked，避免「本機能建置、CI 缺檔」。
- CI 綠燈是必要條件，不是 UI、重播、音效或真實資料行為的替代品。

---

## 禁止

- `Co-Authored-By:` / `Signed-off-by:` 中出現工具、agent 或模型（claude、copilot、
  cursor、gpt、codex、gemini、`[bot]`…）。**人類的 `Co-authored-by:` 是允許的** ——
  GitHub squash 一個多作者 PR 時會自己寫這個 trailer，而那是唯一還留著的「誰寫的」
  紀錄，一刀切禁掉反而會摧毀它本來要保護的東西。閘門判斷的是這個 trailer **掛誰的
  名**，不是它存不存在。
- `Generated with`、機器人 emoji 或宣傳文字。
- `fix: update`、`feat: stuff`、`misc changes` 等無法判斷行為的摘要。
- 把無關修改、格式化整個 repo 或臨時偵錯檔混入功能 commit。
- 未驗證就寫「所有平台正常」、「完全符合 legacy」或「production 已確認」。
- 為了通過視覺比較而改動 legacy 基準。
- 在未確認遠端協作狀態前 force push。

commit 作者對內容負責；工具不應把自己寫進專案歷史。

---

## 完整範例

### Replay 修正

```text
fix(replay): keep alert overlays synchronized during playback

Platform: desktop

Fix(zh-Hant): 重播時黃色警示框不再提早消失，PiP 也會在正確時間顯示
Fix(en-US): replay now keeps the yellow alert frame visible and shows PiP at the correct time
```

### 震度速報語音修正

```text
fix(speech): announce maximum-intensity counties

Fix(zh-Hant): 震度速報會念出最高震度地區的縣市名稱
Fix(en-US): intensity alerts now announce counties at the maximum intensity
```

### 地圖最佳化

```text
perf(map): reuse the terrain source while updating overlays

Optimization(zh-Hant): 更新即時資料時地形底圖不再閃爍
Optimization(en-US): the terrain base map no longer flickers during real-time updates
```

### 不進使用者更新日誌

```text
docs: define the commit and verification rules
test(replay): add a fixed intensity-event fixture
ci: compile the desktop app on every release target
```
