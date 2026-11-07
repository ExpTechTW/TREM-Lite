# TREM-Lite native：Rust + winit + wgpu 移植規格

把桌面版從 Tauri + WebView + React + MapLibre GL JS 移植成純原生 Rust。目標是**功能完整**、
**資源用量盡可能低**，讓使用者試用後決定要不要繼續。不動 `packages/`、`apps/desktop/`、`apps/web/`、
`legacy/` 的任何檔案，它們是對照基準。

## 硬規則

- TS 是行為規格。**逐檔移植，邏輯、門檻、時序、log 訊息都要跟原檔一致**，不要憑印象重寫，
  原檔註解裡寫的踩坑理由要帶過來（濃縮成 Rust 註解）。
- 不用任何 UI 框架、不用 WebView、不用 MapLibre。
- 不可用 `unwrap`/`expect` 處理執行期資料（網路、檔案、JSON）。一個模組失敗不能拖垮其他模組。
- 不要 `git commit` / `push`。不要動 `apps/native/` 以外的檔案。
- 註解用英文，log 訊息照原檔的繁體中文。`cargo fmt` 要乾淨，`cargo clippy` 不能有新增警告，`cargo test` 要過。

## 效率規則（這是這次移植的目的，違反就是錯）

1. **事件驅動**：沒有東西變就不畫。`ControlFlow::Wait`/`WaitUntil`，閒置時 CPU 接近 0。
   不准有固定 60fps 的 loop。只有相機動畫進行中才連續出幀。
2. **隱藏就不畫**：視窗隱藏時不 acquire surface、不畫任何東西；主視窗隱藏且沒有 PiP 時，釋放圖磚 GPU 資源與字形圖集，
   要顯示時再重建。設定視窗關閉就整個銷毀（視窗、surface、狀態），不要藏起來。
3. **圖形常駐 GPU**：圖磚只在載入時切三角形一次（worker thread），之後只改相機 uniform。鄉鎮著色只更新一張 lookup texture，
   不重新切圖磚。測站點用 instancing，只有資料變動才上傳。
4. **不用 MSAA**：線條用 fragment shader 算邊緣 alpha，填色靠上面的外框線蓋邊緣，UI 用 SDF。
5. **Hot path 不配置記憶體**：每秒的 RTS 幀重用 buffer。避免在迴圈裡 `format!`、clone 字串。
6. **快取有上限**：圖磚 GPU 記憶體 LRU（向量 64 MB、DEM 48 MB），字形圖集固定大小，超過就淘汰。
7. **關閉不需要的 crate feature**，`[profile.release]` 用 `lto = true`、`codegen-units = 1`、`opt-level = 3`、`strip = true`。
   release 維持 `panic = "unwind"`，事件處理器要 `catch_unwind` 隔離（對應 lib/events.ts 的行為）。

## 架構

```
apps/native/
  Cargo.toml            單獨的 crate（不併進 apps/desktop 的 workspace），二進位檔名 trem-lite-native
  assets/fonts/         Manrope.ttf、NotoSansTC.ttf（legacy 的 subset woff2 轉成 TTF 的 variable font）
  src/
    main.rs             CLI、單一實例、logger、tokio runtime、winit event loop
    app.rs              `App`：擁有所有狀態（對應 variable + ui）、事件匯流排、計時器
    events.rs           `Event` enum（對應 TremEvents），同步派發，順序同 features/index.ts
    timers.rs           setTimeout/setInterval 的對應，驅動 ControlFlow::WaitUntil
    net/                http（http_proxy.rs + endpoints.rs 去 Tauri）、cache（http_cache.rs）、sse、ntp、fixture
    backend/            config、logging、version、audio、awake、math、ml_intensity、updater（從 Tauri 版搬，去 Tauri 依賴）
    domain/             types、utils、eew_calculator、eew_math、region、constants、bindata
    features/           data、rts、eew、box、cross、estimate、focus、intensity、lpgm、report、replay、loop、log、update、window
    map/                camera、mvt、tessellate、tiles、dem、scene（圖層與疊加資料）
    render/             gpu、surface、map_pass、ui_pass、text、image、shaders/*.wgsl、screenshot
    ui/                 widgets、overlays/*、settings/*、pip
    platform/           tray、notify、speech、autostart、single_instance、dock（macOS）
```

- **執行緒**：主執行緒跑 winit、所有狀態、所有渲染。tokio（2 個 worker）跑網路。圖磚解碼切割用獨立 worker thread。
  背景工作一律透過 `EventLoopProxy<Msg>` 把結果丟回主執行緒，不共享可變狀態。
- **事件**：TS 的 `events.emit` 是同步的，Rust 也要同步：`app.emit(Event::X)` 依 `initFeatures()` 的順序直接呼叫各模組的
  `on_event(&mut App, &Event)`，每個呼叫包 `catch_unwind`，失敗的 log 規則同 lib/events.ts（同錯誤每分鐘一次）。
- **TS 的 await**：改成「發 tokio 任務，完成後 Msg 回主執行緒接著做」。注意保留原本的競態防護（serial 檢查、「還是最新嗎」）。
- **資料目錄**：identifier 用 `com.exptech.trem-lite.native`，跟正式版完全隔開（config、快取、log、模型）。
  第一次啟動時若找到正式版的 `config.yml`，只讀取匯入設定（不寫回去、不動它）。
- **`other-auto-start` 預設 false，匯入時也不帶過去**：試用版不要自己登錄開機啟動，使用者打開開關才登錄。這是唯一刻意跟原版不同的預設值。
- **環境變數 `TREM_FIXTURE_DIR`**：設定時 HTTP 層完全不連線，從該目錄讀回應（規則見 net/fixture）。所有開發驗證都用這個。

## 繪圖規格

- 色彩：surface 用**非 sRGB** 格式（Bgra8Unorm / Rgba8Unorm），直接在 gamma 空間混色，才會跟 CSS 的結果一樣。
- `power_preference: LowPower`（map.ts 註解：雙顯卡筆電不要喚醒獨顯）。`desired_maximum_frame_latency` 設 2 以下。
  adapter 取得順序：一般 → GL 後端 → `force_fallback_adapter`（軟體）。全部失敗要 log 並讓資料、音效、通知繼續運作，不能 panic。
  surface/device lost 要能重建（對應 map.ts 的 WebGL context lost 處理）。
- **截圖模式**：`trem-lite-native --screenshot out.png --size 1280x815 --scale 1 [--preview <state>] [--page main|pip|settings] [--settings-tab <id>]`
  畫到離屏 texture、讀回存 PNG、結束，不開視窗。所有視覺驗收都走這條。

## 地圖規格

底圖同 map.ts：向量圖磚 `https://static.lb.exptech.dev/api/v1/map/tiles/{z}/{x}/{y}.pbf`（maxzoom 9，MVT，source layer：`global`、`city`、`town`、`tsunami`，
town 的 feature id 來自屬性 `CODE`），DEM `.../terrain/{z}/{x}/{y}.png`（Mapbox Terrain-RGB，512px，maxzoom 11，bounds 110,10,132,35）。
圖磚都走 net 層（HTTP 快取，TILE_FRESH_MS = 7 天，timeout 15s；404/204 視為空圖磚）。

- 相機：Web Mercator，世界寬 `512 * 2^zoom`（同 MapLibre），zoom 4–12，初始 center 121.6,23.5、zoom 6.8，不可旋轉傾斜。
  `fit_bounds(bounds, padding, duration)` 語意要跟 MapLibre 一致（focus.ts 依賴它），含 `padding` 物件、`maxZoom`、ease 動畫。
- 互動：拖曳平移（含慣性可省略）、滾輪/觸控板縮放（以游標為中心）、雙擊放大、pinch。手動操作要觸發 focus 鎖定（見 focus.ts）。
- 圖層順序（底到頂）：background、global fill、county fill、town fill（lookup texture 上色）、hillshade、town-outline、county-outline、tsunami（opacity 0，可不畫但資料要留），
  接著依 `MapLoad` 訂閱順序的疊加層（各 feature 檔案的 addLayer 是規格，含 beforeId）。
- Hillshade：在 worker 把 DEM 預算成每張圖磚一張 RG8 texture（陰影、高光強度），公式照 MapLibre（`node_modules/maplibre-gl/src/shaders/hillshade*.glsl`，
  若 npm 包裡沒有 src 就讀 dist 裡的 shader 字串），illumination-direction 335、exaggeration 0.3。DEM 只用來算這張圖，算完就丟。
- 向量圖磚的 tile 邊界：多邊形被切開的邊不要畫外框線（MVT 會有 buffer，line 用 source layer 自己的幾何）。
- 疊加層 primitive：circle（instanced，SDF 抗鋸齒）、icon（sprite atlas，`icon-size` 依 zoom 內插，排序照 `symbol-sort-key`）、
  line（寬度以螢幕像素為單位）、fill（波前 S 波半透明）。圖示：intensity-*、intensity-square-*、lpgm-* 由程式畫（對應 domain/utils.ts 的 createIntensityIcon*），cross/gps 用 legacy 的 PNG（嵌入）。

## UI 規格

- `styles/globals.css` 與各 overlay 的 Tailwind class 是視覺規格：位置、尺寸、字級、顏色、圓角、邊框、陰影、transition 都要對到。
- 桌面視窗 minWidth 900 × minHeight 680，所以只需要 `max-width: 980px` 那段響應式；`max-width: 640px`、`max-height` 那幾段用不到，不移植。
- 不寫 layout 引擎：每個 overlay 用明確座標與文字量測（對應 CSS 算出來的值）。需要共用的就是 `Rect`、`Ui`（quad、text、image、clip、hit test、scroll、hover/press 狀態、cursor、tooltip）。
- 文字：cosmic-text（shaping + swash 光柵化），Manrope 優先、Noto Sans TC 其次（同 CSS font stack），variable font 的 `wght` 要生效，`tabular-nums` 要做到。
  嵌入字型缺字時才載入系統字型當 fallback（不要啟動就掃系統字型）。
- 動畫：只有進行中才要求下一幀（報告抽屜 0.6s transform、hover、flash keyframes 等）。

## 模組對照

| 原檔（packages/core/src） | Rust | 備註 |
|---|---|---|
| lib/events.ts、lib/types.ts、lib/variable.ts、lib/variable.ui.ts | events.rs、domain/types.rs、app.rs | |
| lib/constants.ts、domain/utils.ts、domain/region.ts、lib/bindata.ts | domain/ | `src/data/*.bin` 用 include_bytes! |
| domain/eewCalculator.ts、domain/eewMath.ts | domain/ | 預估震度用 Rust 的 ml_intensity（mlIntensity.ts、mlWorker.ts 是網頁版用的，不移植） |
| features/data/* | features/data | SSE 用 reqwest stream；背景節流相關的 WebView workaround 不移植，但邏輯（rtsAsleep 等）要移植 |
| features/rts、eew、box、cross、estimate、focus、intensity、lpgm、report、replay、loop、log、update、window | features/ | 地圖操作改呼叫 map/scene API |
| features/map/map.ts、lib/mapSource.ts、lib/http/mapProtocol.ts | map/ | |
| features/pip/PipView.tsx、lib/pipBridge.ts | ui/pip.rs、features/window | PiP 現在跟主視窗同程序，不需要 bridge 的 revision 握手，但「畫好才顯示」的語意要保留 |
| overlays/*、components/*、styles/globals.css | ui/overlays | WebWelcome 是網頁版用的，不移植 |
| features/settings/* | ui/settings | |
| lib/audioClient.ts、lib/speechClient.ts、lib/notificationClient.ts、lib/autostartClient.ts、lib/ntp.ts、lib/logger.ts、lib/windows.ts | platform/、backend/、net/ | webAudio、logStore、webBackend、regions.ts 是網頁版用的，不移植 |
| apps/desktop/src-tauri/src/* | backend/、net/、platform/ | 搬過來去掉 Tauri；測試一起搬 |

## 預覽狀態

`--preview <state>` 對應 `packages/core/src/preview.tsx`：同樣的 mock 資料、同樣的固定時間，state 為 `idle|trigger|eew|cancel|rts|warnings|survey`。
背景純色 `#1f2025`、不畫地圖（同 preview.tsx）。視覺比對就是把 web preview 的截圖跟這個比。

## 進度

- [x] R1 繪圖核心：crate、gpu、quad/text/image、截圖模式
- [x] R2 後端：config、logging、http、cache、endpoints、ntp、math、ml_intensity、audio、awake、version
- [x] R3 地圖引擎：相機、圖磚、切割、DEM、圖層、互動
- [x] R4 資料與功能：types、events、data、rts、eew、box、cross、estimate、focus、intensity、lpgm、report、replay、loop、log
- [x] R5 主畫面 UI：overlays、PiP、預覽狀態
- [x] R6 設定視窗
- [x] R7 平台：視窗生命週期、系統匣、單一實例、開機啟動、Dock、通知、語音、更新
- [x] R8 打包與驗收
