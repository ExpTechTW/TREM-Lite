//! The plugin-window host — the V4 replacement for Electron's
//! `open-plugin-window` IPC (`legacy/src/main.js:628-780`).
//!
//! A V3 extension that needs its own window calls
//! `ipcRenderer.send("open-plugin-window", { pluginId, htmlPath, options })`
//! from the main window, and the page it names answers with
//! `ipcRenderer.send("send-to-plugin-window", …)`. Neither side can work in V4
//! as it did: there is no Node in the webview, and a plugin page cannot be
//! loaded from `file://` — `weather/web/weather.html` fetches
//! `./data/region.json` and pulls maplibre-gl from a CDN, so it needs a real
//! origin.
//!
//! So this is the host, in three pieces:
//!
//! 1. A `trem-plugin://` protocol that serves exactly one plugin's folder.
//!    HTML going out gets a small `require`/`electron` bootstrap injected,
//!    because the page is served with no bundler and nothing else would define
//!    them. `ipcRenderer.send` becomes the `plugin_window_ipc` command and
//!    messages arrive back through `WebviewWindow::eval` — the same trick V3's
//!    main process used, minus the IPC plumbing.
//! 2. One window per plugin, labelled `plugin-<name>`, so a repeat
//!    `open-plugin-window` replaces the one already open rather than piling up.
//! 3. One dispatcher for every channel V3 answered, so the main window's
//!    `ipcRenderer.send` and a plugin window's own calls both land here.
//!
//! Windows serves custom schemes as `http://<scheme>.localhost/<path>`, macOS
//! and Linux as `<scheme>://<host>/<path>`; `window_url` writes the platform's
//! form and `resolve` reads both.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// The custom scheme a plugin page is served under.
const SCHEME: &str = "trem-plugin";
/// The sandbox name the extension host gives the plugins folder
/// (`packages/core/src/features/plugin/sandbox.ts`). A plugin builds its
/// window path from `ctx.info.pluginDir`, so this is what arrives here.
const ROOT: &str = "/plugins";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWindowOptions {
    width: Option<f64>,
    height: Option<f64>,
    min_width: Option<f64>,
    min_height: Option<f64>,
    title: Option<String>,
    resizable: Option<bool>,
}

#[derive(Serialize)]
pub struct WindowInfo {
    window_id: String,
    plugin_id: String,
    html_path: String,
    options: Value,
}

/// Register the `trem-plugin://` protocol. Must run before `run()`, which is
/// what `register_uri_scheme_protocol` is for.
pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol(SCHEME, |ctx, request| serve(ctx.app_handle(), &request))
}

/// The window URL for a page, in the form the platform's webview expects.
fn window_url(plugin: &str, page: &str) -> Result<Url, String> {
    let text = if cfg!(windows) {
        format!("http://{SCHEME}.localhost{ROOT}/{plugin}/{page}")
    } else {
        format!("{SCHEME}://plugins/{plugin}/{page}")
    };
    Url::parse(&text).map_err(|e| format!("擴充功能視窗網址不合法：{e}"))
}

/// `/plugins/<name>/<page>` — the path a plugin builds from `info.pluginDir`.
fn split_html_path(path: &str) -> Result<(String, String), String> {
    let normalized = path.replace('\\', "/");
    let marker = format!("{ROOT}/");
    let rest = match normalized.find(&marker) {
        Some(index) => &normalized[index + marker.len()..],
        None => return Err(format!("擴充功能視窗的路徑不在 plugins 資料夾內：{path}")),
    };
    let mut parts = rest.splitn(2, '/');
    let name = parts.next().unwrap_or_default().to_string();
    let page = parts.next().unwrap_or("index.html");
    if !crate::plugin::valid_name(&name) {
        return Err(format!("擴充功能視窗的套件名稱不合法：{path}"));
    }
    Ok((
        name,
        if page.is_empty() { "index.html" } else { page }.to_string(),
    ))
}

// -- serving ---------------------------------------------------------------

fn mime_for(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The plugin folder's file for a request path, or the status to answer with.
fn resolve(
    app: &tauri::AppHandle,
    request: &Request<Vec<u8>>,
) -> Result<PathBuf, (StatusCode, String)> {
    let uri = request.uri();
    let path = uri.path();
    // Windows: host `trem-plugin.localhost`, path `/plugins/…`.
    // macOS/Linux: host `plugins`, path `/…`.
    let full = if path.starts_with(&format!("{ROOT}/")) || path == ROOT {
        path.to_string()
    } else {
        format!("/{}{}", uri.host().unwrap_or_default(), path)
    };
    let rest = full
        .strip_prefix(&format!("{ROOT}/"))
        .or_else(|| full.strip_prefix(ROOT))
        .unwrap_or_default()
        .trim_start_matches('/');
    let bad = |status: StatusCode, message: String| (status, message);
    let mut parts = rest.splitn(2, '/');
    let name = parts.next().unwrap_or_default();
    let page = parts.next().unwrap_or("index.html");
    if !crate::plugin::valid_name(name) {
        return Err(bad(
            StatusCode::FORBIDDEN,
            format!("不是合法的擴充功能名稱：{name}"),
        ));
    }
    let page = if page.is_empty() { "index.html" } else { page };
    let relative =
        crate::plugin::safe_relative(page).map_err(|e| bad(StatusCode::BAD_REQUEST, e))?;
    let file = crate::plugin::plugin_dir(app, name)
        .map_err(|e| bad(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .join(relative);
    // `safe_relative` already refuses `..` and absolute parts; this is the
    // second half of the check, so a link planted in the folder cannot reach
    // outside it either.
    if !file.is_file() {
        return Err(bad(
            StatusCode::NOT_FOUND,
            format!("擴充功能 {name} 沒有這個檔案：{page}"),
        ));
    }
    Ok(file)
}

fn serve(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let file = match resolve(app, request) {
        Ok(file) => file,
        Err((status, message)) => {
            log::warn!("擴充功能視窗要求 {uri}：{message}");
            return plain(status, &message);
        }
    };
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!("擴充功能視窗要求 {uri}：讀不到檔案：{e}");
            return plain(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("讀不到檔案：{e}"),
            );
        }
    };
    let name = file
        .strip_prefix(crate::plugin::plugins_dir(app).unwrap_or_default())
        .ok()
        .and_then(|rest| {
            rest.components()
                .next()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    let mime = mime_for(&file.to_string_lossy());
    let body = if mime.starts_with("text/html") {
        match String::from_utf8(bytes) {
            Ok(html) => inject(&html, &name).into_bytes(),
            Err(e) => {
                return plain(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("網頁不是 UTF-8：{e}"),
                )
            }
        }
    } else {
        bytes
    };
    // A page that never loads leaves a blank window and no way to tell why, so
    // the page itself is always recorded; its assets only when asked for.
    if mime.starts_with("text/html") {
        log::info!("擴充功能視窗載入 {uri}（{} 位元組）", body.len());
    } else {
        log::debug!("擴充功能視窗讀取 {uri}（{} 位元組）", body.len());
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap_or_else(|e| plain(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

// -- the page bootstrap ----------------------------------------------------

/// Defined for every plugin page: `require("electron")`, `fetch`-based
/// `require` for a plugin's own files, and the `process` fields pages read.
/// Kept in ES5-style plain JavaScript because it is injected as-is.
const BOOTSTRAP: &str = r##"<script>
(function () {
  var name = __PLUGIN__;
  var platform = __PLATFORM__;
  var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  var listeners = Object.create(null);

  if (!invoke) {
    // Nothing below works without it, and a silent window is worse than a
    // loud one: the plugin's own log gets this line with the rest.
    console.error("擴充功能視窗拿不到應用的 IPC，這個視窗無法與擴充功能通訊。");
  }

  // V3 ran these pages in Electron, where a throw reached the app's log. Here
  // it would reach nobody, and a blank window with no reason in the log is the
  // worst way for this host to fail, so both kinds of failure are forwarded:
  // a script that did not load (capture phase, `error` on the element) and a
  // script that threw.
  window.addEventListener("error", function (event) {
    var target = event && event.target;
    if (target && target !== window && (target.src || target.href)) {
      send("__page-error", "載入失敗：" + (target.src || target.href));
      return;
    }
    var where = event && event.filename ? "（" + event.filename + ":" + event.lineno + "）" : "";
    send("__page-error", String((event && event.message) || "未知錯誤") + where);
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    send("__page-error", "未處理的 Promise：" + String((reason && reason.message) || reason));
  });

  // Rust calls this to hand a message to the page (V3: webContents.send).
  window.__tremDispatch = function (channel, payload) {
    var list = listeners[channel];
    if (!list) { return; }
    for (var i = 0; i < list.length; i += 1) {
      try { list[i]({}, payload); } catch (error) { console.error("擴充功能視窗的事件處理失敗：", error); }
    }
  };

  function send(channel, payload) {
    if (!invoke) { return Promise.resolve(null); }
    return invoke("plugin_window_ipc", {
      plugin: name, channel: channel, payload: payload === undefined ? null : payload, source: "plugin"
    }).catch(function (error) { console.error("擴充功能視窗傳送失敗：", error); return null; });
  }

  function add(channel, handler, once) {
    var list = listeners[channel] || (listeners[channel] = []);
    var entry = once
      ? function (event, payload) { ipcRenderer.removeListener(channel, entry); return handler(event, payload); }
      : handler;
    list.push(entry);
    return ipcRenderer;
  }

  var ipcRenderer = {
    send: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      send(channel, args.length <= 1 ? args[0] : args);
      return ipcRenderer;
    },
    sendSync: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      send(channel, args.length <= 1 ? args[0] : args);
      return null;
    },
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      return send(channel, args.length <= 1 ? args[0] : args);
    },
    on: function (channel, handler) { return add(channel, handler, false); },
    once: function (channel, handler) { return add(channel, handler, true); },
    off: function (channel, handler) { return ipcRenderer.removeListener(channel, handler); },
    removeListener: function (channel, handler) {
      var list = listeners[channel];
      if (!list) { return ipcRenderer; }
      var index = list.indexOf(handler);
      if (index >= 0) { list.splice(index, 1); }
      return ipcRenderer;
    },
    removeAllListeners: function (channel) {
      if (channel) { delete listeners[channel]; } else { listeners = Object.create(null); }
      return ipcRenderer;
    }
  };

  var process = { platform: platform, versions: {}, env: {}, argv: [] };

  function load(id) {
    var url = new URL(id, document.baseURI).href;
    var request = new XMLHttpRequest();
    request.open("GET", url, false);
    request.send(null);
    if (request.status !== 200 && request.status !== 0) {
      throw new Error("找不到模組 " + id + "（" + request.status + "）");
    }
    var module = { exports: {} };
    var factory = new Function("module", "exports", "require", "process", request.responseText + "\n//# sourceURL=" + url);
    factory(module, module.exports, require, process);
    return module.exports;
  }

  function require(id) {
    if (id === "electron" || id === "node:electron") {
      return {
        ipcRenderer: ipcRenderer,
        contextBridge: { exposeInMainWorld: function (key, value) { window[key] = value; } },
        shell: {
          openPath: function (path) { return send("open-path", { path: path }); },
          openExternal: function (url) { return send("open-external", { url: url }); }
        },
        remote: undefined
      };
    }
    if (id === "process") { return process; }
    if (id.charAt(0) === "." || id.charAt(0) === "/") { return load(id); }
    throw new Error("擴充功能視窗不能使用模組 " + id + "。");
  }

  window.require = require;
  window.process = process;
  window.module = { exports: {} };
  window.exports = window.module.exports;
  window.ipcRenderer = ipcRenderer;
})();
</script>"##;

/// Insert the bootstrap at the top of the page's `<head>`, or at the top of
/// the file for a fragment without one.
fn inject(html: &str, plugin: &str) -> String {
    let script = BOOTSTRAP
        .replace(
            "__PLUGIN__",
            &serde_json::to_string(plugin).unwrap_or_else(|_| "\"\"".into()),
        )
        .replace("__PLATFORM__", &format!("\"{}\"", std::env::consts::OS));
    let head = find_ci(html, "<head")
        .and_then(|index| html[index..].find('>').map(|close| index + close + 1));
    match head {
        Some(index) => format!("{}{}{}", &html[..index], script, &html[index..]),
        None => format!("{script}{html}"),
    }
}

/// Byte-wise, ASCII-case-insensitive search. `<head` is ASCII, and a UTF-8
/// continuation byte never equals one, so slicing bytes is safe here.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let target = needle.as_bytes();
    if target.len() > bytes.len() {
        return None;
    }
    (0..=bytes.len() - target.len())
        .find(|&i| bytes[i..i + target.len()].eq_ignore_ascii_case(target))
}

// -- windows ---------------------------------------------------------------

fn window_label(plugin: &str) -> String {
    format!("plugin-{plugin}")
}

fn open_window(
    app: &tauri::AppHandle,
    plugin: &str,
    page: &str,
    options: PluginWindowOptions,
) -> Result<String, String> {
    if !crate::plugin::valid_name(plugin) {
        return Err(format!("不是合法的擴充功能名稱：{plugin}"));
    }
    let relative = crate::plugin::safe_relative(page)?;
    let page = relative.to_string_lossy().replace('\\', "/");
    let label = window_label(plugin);
    // V3 closed the previous window for the same plugin first, so a second
    // click on the nav button reopens rather than stacks.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }
    let url = window_url(plugin, &page)?;
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(
            options
                .title
                .clone()
                .unwrap_or_else(|| format!("擴充功能 {plugin}")),
        )
        .inner_size(
            options.width.unwrap_or(800.0),
            options.height.unwrap_or(600.0),
        )
        .resizable(options.resizable.unwrap_or(true))
        .decorations(true);
    if let (Some(width), Some(height)) = (options.min_width, options.min_height) {
        builder = builder.min_inner_size(width, height);
    }
    let window = builder
        .build()
        .map_err(|e| format!("開啟擴充功能視窗失敗：{e}"))?;
    let _ = window.center();
    log::info!("擴充功能 {plugin} 的視窗已開啟：{page}");
    let _ = app.emit_to(
        "main",
        "plugin-window-opened",
        serde_json::json!({ "success": true, "windowId": plugin, "pluginId": plugin }),
    );
    Ok(label)
}

/// Tell the main window a plugin window went away, the way V3's `closed`
/// handler did. Called from the window event handler in `lib.rs`.
pub fn closed(app: &tauri::AppHandle, label: &str) {
    let Some(plugin) = label.strip_prefix("plugin-") else {
        return;
    };
    log::info!("擴充功能 {plugin} 的視窗已關閉");
    let _ = app.emit_to(
        "main",
        "plugin-window-closed",
        serde_json::json!({ "windowId": plugin, "pluginId": plugin }),
    );
}

fn dispatch(
    app: &tauri::AppHandle,
    plugin: &str,
    channel: &str,
    payload: Value,
) -> Result<(), String> {
    let label = window_label(plugin);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("擴充功能 {plugin} 沒有開啟的視窗"))?;
    let channel = serde_json::to_string(channel).unwrap_or_else(|_| "\"\"".into());
    let payload = serde_json::to_string(&payload).unwrap_or_else(|_| "null".into());
    window
        .eval(format!(
            "window.__tremDispatch && window.__tremDispatch({channel}, {payload})"
        ))
        .map_err(|e| format!("傳送訊息給擴充功能視窗失敗：{e}"))
}

fn broadcast(
    app: &tauri::AppHandle,
    plugin: &str,
    channel: &str,
    payload: Value,
) -> Result<(), String> {
    let channel = serde_json::to_string(channel).unwrap_or_else(|_| "\"\"".into());
    let payload = serde_json::to_string(&payload).unwrap_or_else(|_| "null".into());
    let prefix = window_label(plugin);
    let mut sent = 0;
    for (label, window) in app.webview_windows() {
        if label == prefix {
            let _ = window.eval(format!(
                "window.__tremDispatch && window.__tremDispatch({channel}, {payload})"
            ));
            sent += 1;
        }
    }
    if sent == 0 {
        return Err(format!("擴充功能 {plugin} 沒有開啟的視窗"));
    }
    Ok(())
}

fn value_text(payload: &Value, key: &str) -> Option<String> {
    payload.get(key)?.as_str().map(str::to_string)
}

fn open_folder(path: PathBuf, what: &str) {
    let _ = std::fs::create_dir_all(&path);
    let text = path.to_string_lossy().into_owned();
    log::info!("開啟{what}：{text}");
    if let Err(e) = tauri_plugin_opener::open_path(&text, None::<&str>) {
        log::warn!("開啟{what}失敗：{e}");
    }
}

// -- commands --------------------------------------------------------------
//
// Every one of these is `async` on purpose. A command declared without it is
// run inline on the thread the IPC arrived on, which is the main thread, inside
// WebView2's own message callback; `WebviewWindowBuilder::build` would then
// create a window and a second WebView2 controller back inside that callback,
// which is what made the app freeze solid the moment an extension opened its
// window. `async` moves the body onto the async runtime, so the window is built
// from the event loop the way any other window is.

#[tauri::command]
pub async fn plugin_window_open(
    app: tauri::AppHandle,
    plugin: String,
    page: String,
    options: Option<PluginWindowOptions>,
) -> Result<String, String> {
    open_window(&app, &plugin, &page, options.unwrap_or_default())
}

#[tauri::command]
pub async fn plugin_window_close(app: tauri::AppHandle, plugin: String) -> Result<(), String> {
    let label = window_label(&plugin);
    match app.get_webview_window(&label) {
        Some(window) => window
            .close()
            .map_err(|e| format!("關閉擴充功能視窗失敗：{e}")),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn plugin_window_send(
    app: tauri::AppHandle,
    plugin: String,
    channel: String,
    payload: Option<Value>,
) -> Result<(), String> {
    dispatch(&app, &plugin, &channel, payload.unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn plugin_window_broadcast(
    app: tauri::AppHandle,
    plugin: String,
    channel: String,
    payload: Option<Value>,
) -> Result<(), String> {
    broadcast(&app, &plugin, &channel, payload.unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn plugin_window_list(app: tauri::AppHandle, plugin: Option<String>) -> Vec<WindowInfo> {
    let mut out = Vec::new();
    for (label, window) in app.webview_windows() {
        let Some(name) = label.strip_prefix("plugin-") else {
            continue;
        };
        if let Some(wanted) = &plugin {
            if wanted != name {
                continue;
            }
        }
        out.push(WindowInfo {
            window_id: name.to_string(),
            plugin_id: name.to_string(),
            html_path: window.url().map(|url| url.to_string()).unwrap_or_default(),
            options: serde_json::json!({}),
        });
    }
    out.sort_by(|a, b| a.window_id.cmp(&b.window_id));
    out
}

/// The one entry point every `ipcRenderer.send` reaches: the main window's
/// extensions (`source` `"main"`) and a plugin window's own page
/// (`source` `"plugin"`). V3 answered all of these in the main process.
#[tauri::command]
pub async fn plugin_window_ipc(
    app: tauri::AppHandle,
    plugin: String,
    channel: String,
    payload: Option<Value>,
    source: Option<String>,
) -> Result<(), String> {
    let payload = payload.unwrap_or(Value::Null);
    let from_page = source.as_deref() == Some("plugin");
    match channel.as_str() {
        // A page's own failures, forwarded by the bootstrap. V3 showed these in
        // the app's log; without this a blank window says nothing at all.
        "__page-error" => {
            log::warn!(
                "擴充功能視窗 {plugin}：{}",
                payload.as_str().unwrap_or_default()
            );
            return Ok(());
        }
        "open-plugin-window" => {
            let html = value_text(&payload, "htmlPath")
                .ok_or_else(|| "open-plugin-window 缺少 htmlPath".to_string())?;
            let (target, page) = match split_html_path(&html) {
                Ok(pair) => pair,
                // A plugin that built the path some other way still gets its
                // own folder, which is what the relative path was for.
                Err(_) => (plugin.clone(), html.trim_start_matches("./").to_string()),
            };
            let options = payload
                .get("options")
                .and_then(|options| serde_json::from_value(options.clone()).ok())
                .unwrap_or_default();
            return open_window(&app, &target, &page, options).map(|_| ());
        }
        "send-to-plugin-window" => {
            // Plugins address their own window by plugin id, not by the
            // window id V3 handed back (`eew-info/index.js:66`).
            let target = value_text(&payload, "windowId")
                .or_else(|| value_text(&payload, "pluginId"))
                .unwrap_or_else(|| plugin.clone());
            let channel = value_text(&payload, "channel")
                .ok_or_else(|| "send-to-plugin-window 缺少 channel".to_string())?;
            let inner = payload.get("payload").cloned().unwrap_or(Value::Null);
            return dispatch(&app, &target, &channel, inner);
        }
        "broadcast-to-plugin-windows" => {
            let target = value_text(&payload, "pluginId").unwrap_or_else(|| plugin.clone());
            let channel = value_text(&payload, "channel")
                .ok_or_else(|| "broadcast-to-plugin-windows 缺少 channel".to_string())?;
            let inner = payload.get("payload").cloned().unwrap_or(Value::Null);
            return broadcast(&app, &target, &channel, inner);
        }
        "close-plugin-window" => {
            let target = payload
                .as_str()
                .map(str::to_string)
                .or_else(|| value_text(&payload, "windowId"))
                .unwrap_or_else(|| plugin.clone());
            return plugin_window_close(app, target).await;
        }
        "close-plugin-windows" => {
            let target = payload
                .as_str()
                .map(str::to_string)
                .or_else(|| value_text(&payload, "pluginId"))
                .unwrap_or_else(|| plugin.clone());
            return plugin_window_close(app, target).await;
        }
        "get-plugin-windows" => {
            let target = payload
                .as_str()
                .map(str::to_string)
                .or_else(|| value_text(&payload, "pluginId"))
                .unwrap_or_else(|| plugin.clone());
            let windows = plugin_window_list(app.clone(), Some(target.clone())).await;
            let _ = app.emit_to(
                "main",
                "plugin-windows-list",
                serde_json::json!({ "pluginId": target, "windows": windows }),
            );
            return Ok(());
        }
        "all-reload" => {
            log::info!("重新載入所有視窗");
            for (_, window) in app.webview_windows() {
                let _ = window.eval("location.reload()");
            }
            return Ok(());
        }
        "reload" => return plugin_window_eval(&app, &plugin, from_page, "location.reload()"),
        "openDevtool" => {
            // `open_devtools` is compiled only when devtools exist (see lib.rs):
            // a release binary has no such method, so the arm answers the
            // plugin without doing anything there instead of failing to build.
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window(
                &(if from_page {
                    window_label(&plugin)
                } else {
                    "main".into()
                }),
            ) {
                window.open_devtools();
            }
            return Ok(());
        }
        "toggleFullscreen" => {
            let label = if from_page {
                window_label(&plugin)
            } else {
                "main".into()
            };
            if let Some(window) = app.get_webview_window(&label) {
                let full = window.is_fullscreen().unwrap_or(false);
                let _ = window.set_fullscreen(!full);
            }
            return Ok(());
        }
        "hide" => {
            if from_page {
                // A plugin window has no tray to hide into; V3 hid the window
                // and only `toggleFullscreen`/the nav could bring it back.
                return plugin_window_close(app, plugin).await;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            return Ok(());
        }
        "minimize-window" => return window_state_call(&app, &plugin, from_page, "minimize"),
        "maximize-window" => return window_state_call(&app, &plugin, from_page, "maximize"),
        "restore-window" => return window_state_call(&app, &plugin, from_page, "unminimize"),
        "openPluginFolder" => {
            let dir = crate::plugin::plugins_dir(&app).map_err(|e| e)?;
            return Ok(open_folder(dir, "擴充功能資料夾"));
        }
        "openTempFolder" => {
            // V3 copied a plugin into `plugins-temp` before running it; V4
            // runs it from the folder it was installed in.
            let dir = crate::plugin::plugin_dir(&app, &plugin)?;
            return Ok(open_folder(dir, "擴充功能資料夾"));
        }
        "openConfigFolder" => {
            let dir = crate::plugin::base_dir(&app)?;
            return Ok(open_folder(dir, "設定資料夾"));
        }
        "openReplayFolder" => {
            // V4 keeps no replay folder of its own.
            let dir = crate::plugin::base_dir(&app)?.join("replay");
            return Ok(open_folder(dir, "重播資料夾"));
        }
        "open-path" | "open-external" => {
            if let Some(path) = value_text(&payload, "path") {
                let _ = tauri_plugin_opener::open_path(&path, None::<&str>);
            } else if let Some(url) = value_text(&payload, "url") {
                let _ = tauri_plugin_opener::open_url(&url, None::<&str>);
            }
            return Ok(());
        }
        _ => {}
    }
    if from_page {
        // A plugin window talking to the main window: the extensions running
        // there listen with `ipcRenderer.on(channel, …)`.
        let _ = app.emit_to(
            "main",
            "plugin-window-message",
            serde_json::json!({ "pluginId": plugin, "channel": channel, "payload": payload }),
        );
        return Ok(());
    }
    // The main window talking to its own window — `config-updated` and the
    // like. V3's main process had no handler for these either.
    dispatch(&app, &plugin, &channel, payload)
}

fn plugin_window_eval(
    app: &tauri::AppHandle,
    plugin: &str,
    from_page: bool,
    js: &str,
) -> Result<(), String> {
    let label = if from_page {
        window_label(plugin)
    } else {
        "main".to_string()
    };
    match app.get_webview_window(&label) {
        Some(window) => window
            .eval(js.to_string())
            .map_err(|e| format!("重新載入失敗：{e}")),
        None => Ok(()),
    }
}

fn window_state_call(
    app: &tauri::AppHandle,
    plugin: &str,
    from_page: bool,
    action: &str,
) -> Result<(), String> {
    let label = if from_page {
        window_label(plugin)
    } else {
        "main".into()
    };
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    let _ = match action {
        "minimize" => window.minimize(),
        "maximize" => window.maximize(),
        _ => window.unminimize(),
    };
    Ok(())
}
