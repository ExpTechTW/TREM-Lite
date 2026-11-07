# TREM-Lite native：架構與規則

這個 app 是從 Tauri + React 版逐檔移植來的。原本的原始碼留在 `main` 分支（`packages/core`、
`apps/desktop`），程式註解裡提到的 `.ts` 檔與 `src-tauri` 檔都是指那邊。同一份程式編成桌面版，
也編成瀏覽器版（wasm32 + WebGPU）。

## 規則

- 不可用 `unwrap`/`expect` 處理執行期資料（網路、檔案、JSON）。一個模組失敗不能拖垮其他模組。
- 註解用英文，log 訊息用繁體中文。`cargo fmt` 要乾淨，`cargo clippy` 在桌面與
  `--target wasm32-unknown-unknown` 都不能有警告，`cargo test` 要過。
- 行為由測試釘住：事件軌跡（`testdata/golden/*.txt`）、畫面（`testdata/golden/render/*.png`）、
  圖磚切割（`map_tiles.txt`）、內嵌資料（`encoded_data`）。`UPDATE_GOLDEN=1` 會重寫金檔；
  只在行為本來就該變時用，並在 commit 說明原因。

## 效率規則（這個 app 存在的理由，違反就是錯）

1. **事件驅動**：沒有東西變就不畫。`ControlFlow::Wait`/`WaitUntil`，閒置時 CPU 接近 0。
   不准有固定 60fps 的 loop。只有相機動畫進行中才連續出幀。
2. **隱藏就不畫**：視窗隱藏時不 acquire surface、不畫任何東西；主視窗隱藏且沒有 PiP 時，釋放圖磚 GPU 資源與字形圖集，
   要顯示時再重建。設定視窗關閉就整個銷毀（視窗、surface、狀態），不要藏起來。
3. **圖形常駐 GPU**：圖磚只在載入時切三角形一次（CPU 執行緒池），之後只改相機 uniform。鄉鎮著色只更新一張 lookup texture，
   不重新切圖磚。測站點用 instancing，只有資料變動才上傳。
4. **不用 MSAA**：線條用 fragment shader 算邊緣 alpha，填色靠上面的外框線蓋邊緣，UI 用 SDF。
5. **Hot path 不配置記憶體**：每秒的 RTS 幀重用 buffer。避免在迴圈裡 `format!`、clone 字串。
6. **快取有上限**：圖磚 GPU 記憶體 LRU（向量 64 MB、DEM 48 MB），字形圖集固定大小，超過就淘汰。
7. **多核心**：CPU 工作（圖磚切割、DEM、字形點陣化、模型推論）放在 rayon 的全域執行緒池，一核一條；
   結果的順序與單執行緒相同，測試釘住輸出不變。啟動時能並行的就並行：系統字型在自己的執行緒掃描、
   GPU device 與事件迴圈同時建立、UI 與地圖的繪圖器同時建立。
8. **關閉不需要的 crate feature**，`[profile.release]` 用 `lto = true`、`codegen-units = 1`、`opt-level = 3`、`strip = true`。
   release 維持 `panic = "unwind"`，事件處理器要 `catch_unwind` 隔離。

## 架構

```
apps/native/
  Cargo.toml            二進位檔名 trem-lite-native；桌面與 wasm32 的相依分開列
  assets/               字型（fonts/web 是瀏覽器版用的）、音效、地區資料、地圖圖示、強度模型、app 圖示
  web/                  瀏覽器版的頁面、建置腳本、字型切割腳本
  packaging/            macOS .app 打包
  testdata/             錄好的地震、圖磚與金檔
  src/
    main.rs             CLI、單一實例、logger、tokio runtime、rayon 執行緒池；瀏覽器版的入口在 web.rs
    runner.rs           winit 事件迴圈與三個視窗（瀏覽器版只有主視窗）
    app.rs              `App`：擁有所有狀態、事件匯流排、計時器
    host.rs             app 對外的一切：網路、背景工作、檔案、音效與通知；測試換成錄好的
    exec.rs             async 工作在哪裡跑：桌面是 tokio，瀏覽器是頁面的事件迴圈
    events.rs、timers.rs、variable.rs
    net/                桌面：http（快取代理）、cache、endpoints；共用：sse、ntp、types、fixture；瀏覽器：web（fetch）
    backend/            config、logging、version、audio（瀏覽器是 audio_web）、sound、awake、math、ml_intensity
    domain/             types、utils、region、constants、bindata、palette
    features/           data、streams、rts、eew、estimate、focus、alerts、report、overlays、flash、update、window…
    map/                camera、mvt、tessellate、tiles、dem、scene、icons
    render/             gpu、map_pass、ui_pass、text、screenshot、shaders/*.wgsl
    ui/                 widgets、main_view、settings、pip、icons
    platform/           tray、notify、speech、lifecycle；platform/web 是瀏覽器版
    testing/            測試工具與規格、畫面、資料、bench
```

- **執行緒**：主執行緒跑 winit、所有狀態、所有渲染。tokio（2 個 worker）跑網路。CPU 工作走 rayon 執行緒池。
  背景工作一律透過 `EventLoopProxy<Msg>` 把結果丟回主執行緒，不共享可變狀態。瀏覽器只有一條執行緒：
  rayon 自動退回依序執行，背景工作在下一輪事件迴圈執行。
- **事件**：`app.emit(Event::X)` 同步、依固定順序呼叫各模組的 `on_event`，每個呼叫包 `catch_unwind`，
  同一個錯誤每分鐘只記一次。
- **await**：發 async 任務，完成後 `Msg` 回主執行緒接著做。保留競態防護（serial 檢查、「還是最新嗎」）。
- **資料目錄**：identifier 用 `com.exptech.trem-lite.native`，跟 Tauri 版完全隔開（config、快取、log、模型）。
  第一次啟動時若找到 Tauri 版的 `config.yml`，只讀取匯入設定（不寫回去、不動它）。
- **`other-auto-start` 預設 false，匯入時也不帶過去**：使用者打開開關才登錄開機啟動。
- **環境變數 `TREM_FIXTURE_DIR`**：設定時 HTTP 層完全不連線，從該目錄讀回應，也不出聲、不發通知。所有開發驗證都用這個。

## 繪圖規格

- 色彩：surface 用**非 sRGB** 格式（Bgra8Unorm / Rgba8Unorm），直接在 gamma 空間混色，結果才跟原本的 CSS 一樣。
- `power_preference: LowPower`（雙顯卡筆電不要喚醒獨顯）。`desired_maximum_frame_latency` 設 2 以下。
  adapter 取得順序：一般 → GL 後端 → `force_fallback_adapter`（軟體）。全部失敗要 log 並讓資料、音效、通知繼續運作，不能 panic。
  device lost 要能復原。瀏覽器只用 WebGPU：WebGL2 沒有 storage buffer，畫不了 UI。
- WGSL：`fwidth`、`dpdx`、`textureSample` 只能在 uniform control flow 裡。桌面的 Metal 路徑不檢查，Chrome 會拒絕整條 pipeline。
- **截圖模式**：`trem-lite-native --screenshot out.png --size 1280x815 --scale 1 [--preview <state>] [--page main|pip|settings] [--settings-tab <id>]`
  畫到離屏 texture、讀回存 PNG、結束，不開視窗。

## 地圖規格

底圖：向量圖磚 `https://static.lb.exptech.dev/api/v1/map/tiles/{z}/{x}/{y}.pbf`（maxzoom 9，MVT，source layer：`global`、`city`、`town`、`tsunami`，
town 的 feature id 來自屬性 `CODE`），DEM `.../terrain/{z}/{x}/{y}.png`（Mapbox Terrain-RGB，512px，maxzoom 11，bounds 110,10,132,35）。
圖磚都走 net 層（HTTP 快取，TILE_FRESH_MS = 7 天，timeout 15s；404/204 視為空圖磚）。

- 相機：Web Mercator，世界寬 `512 * 2^zoom`（同 MapLibre），zoom 4–12，初始 center 121.6,23.5、zoom 6.8，不可旋轉傾斜。
  `fit_bounds(bounds, padding, duration)` 的語意跟 MapLibre 一致，含 `padding`、`maxZoom`、ease 動畫。
- 互動：拖曳平移、滾輪/觸控板縮放（以游標為中心）、雙擊放大、pinch。手動操作會觸發 focus 鎖定。
- 圖層順序（底到頂）：background、global fill、county fill、town fill（lookup texture 上色）、hillshade、town-outline、county-outline，
  接著是疊加層。
- Hillshade：DEM 在執行緒池預算成每張圖磚一張 RG8 texture（陰影、高光強度），公式照 MapLibre 的 hillshade shader，
  illumination-direction 335、exaggeration 0.3。DEM 只用來算這張圖，算完就丟。
- 向量圖磚的 tile 邊界：多邊形被切開的邊不要畫外框線。
- 疊加層 primitive：circle（instanced，SDF 抗鋸齒）、icon（sprite atlas，`icon-size` 依 zoom 內插，依 sort key 排序）、
  line（寬度以螢幕像素為單位）、fill（波前 S 波半透明）。intensity、lpgm 的徽章由 UI 繪圖器畫進 sprite，
  震央十字是 `assets/map` 的 PNG。瀏覽器讀不回 GPU，直接嵌入測試釘住的那張 sprite。

## UI 規格

- 畫面以原本 CSS 算出來的位置、尺寸、字級、顏色、圓角、邊框、陰影、transition 為準，現在由畫面金檔釘住。
- 視窗 minWidth 900 × minHeight 680；寬度低於 1080 時報告列表預設收起。
- 不寫 layout 引擎：每個 overlay 用明確座標與文字量測。共用的是 `Rect`、`Ui`（quad、text、image、clip、hit test、scroll、
  hover/press 狀態、cursor、tooltip）。
- 文字：cosmic-text（shaping + swash 光柵化），Manrope 優先、Noto Sans TC 其次，variable font 的 `wght` 要生效，
  `tabular-nums` 要做到。內嵌的 Noto 子集缺的字由系統字型補；系統字型在啟動時於背景掃描、每個字型檔只 mmap 一次。
  瀏覽器沒有系統字型，帶自己的字型（`web/make-font.py`）。
- 動畫：只有進行中才要求下一幀（報告抽屜 0.6s transform、hover、flash 等）。

## 預覽狀態

`--preview <state>` 是原本 `preview.tsx` 的 mock 資料與固定時間，state 為 `idle|trigger|eew|cancel|rts|warnings|survey`。
背景純色 `#1f2025`、不畫地圖。
