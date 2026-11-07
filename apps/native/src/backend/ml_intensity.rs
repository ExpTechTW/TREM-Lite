//! The intensity model's file. trem_core::ml runs it; this is where it comes from. The
//! file is not in the binary: [`prepare`] downloads it on first launch (the web build
//! serves it) and keeps it with the app's data, checked against its SHA-256 each time
//! it is read.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use sha2::{Digest, Sha256};
use trem_core::ml::Model;

/// The file's name, as published and as kept on disk.
const FILE: &str = "intensity_ml_v1.onnx";
/// Where it is fetched from, in order: the web build on GitHub Pages, then the
/// repository's copy through jsDelivr, where `main` keeps it now and where this
/// app keeps it (assets/models) once it is on `main`.
const SOURCES: [&str; 3] = [
    "https://exptechtw.github.io/TREM-Lite/models/intensity_ml_v1.onnx",
    "https://cdn.jsdelivr.net/gh/ExpTechTW/TREM-Lite@main/packages/core/static/models/intensity_ml_v1.onnx",
    "https://cdn.jsdelivr.net/gh/ExpTechTW/TREM-Lite@main/apps/native/assets/models/intensity_ml_v1.onnx",
];
/// The file's SHA-256. Anything else — a truncated download, an error page, a
/// different model — is not used.
const SHA256: &str = "cf2969c816d64413d12d9fa3949e34424529189cc395ca718c8421188ddb5517";
/// How long to wait before trying the download again, offline or on error.
const RETRY: Duration = Duration::from_secs(60);

static MODEL: OnceLock<Model> = OnceLock::new();

/// The compiled model, once [`prepare`] has it.
pub fn model() -> Result<&'static Model, String> {
    MODEL
        .get()
        .ok_or_else(|| "the intensity model is not downloaded yet".into())
}

fn sha256_matches(bytes: &[u8]) -> bool {
    format!("{:x}", Sha256::digest(bytes)) == SHA256
}

/// Make the model ready: the copy in `dir` if it is intact, else a download,
/// kept in `dir` for next time. Tries again every RETRY until it succeeds, so
/// a first launch offline gets the model once it is back online.
pub async fn prepare(dir: PathBuf, client: reqwest::Client) {
    let path = dir.join(FILE);
    loop {
        let bytes = match std::fs::read(&path) {
            Ok(b) if sha256_matches(&b) => Some(b),
            _ => download(&client, &path).await,
        };
        if let Some(bytes) = bytes {
            // ~420k tree nodes to parse and lay out: off the async workers (a browser has
            // only its one thread).
            #[cfg(not(target_arch = "wasm32"))]
            let built = tokio::task::spawn_blocking(move || Model::from_onnx(&bytes))
                .await
                .map_err(|e| e.to_string());
            #[cfg(target_arch = "wasm32")]
            let built: Result<Result<Model, String>, String> = Ok(Model::from_onnx(&bytes));
            match built {
                Ok(Ok(m)) => {
                    let _ = MODEL.set(m);
                    log::info!("ML 震度模型就緒");
                    // Parsing takes several times what the model keeps.
                    crate::platform::lifecycle::return_free_memory();
                    return;
                }
                Ok(Err(e)) => log::error!("ML 震度模型無法使用，刪掉重下載：{e}"),
                Err(e) => log::error!("ML 震度模型建置失敗：{e}"),
            }
            let _ = std::fs::remove_file(&path);
        }
        crate::exec::sleep(RETRY).await;
    }
}

/// The first source that answers with the right file, written to `path`.
async fn download(client: &reqwest::Client, path: &Path) -> Option<Vec<u8>> {
    for url in SOURCES {
        let fetched = async {
            let res = client
                .get(url)
                .timeout(Duration::from_secs(300))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("HTTP {}", res.status()));
            }
            res.bytes().await.map_err(|e| e.to_string())
        }
        .await;
        match fetched {
            Ok(bytes) if sha256_matches(&bytes) => {
                // Written beside and renamed, so an interrupted write never
                // leaves a partial file under the real name.
                let tmp = path.with_extension("part");
                let saved = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
                    .and_then(|()| std::fs::write(&tmp, &bytes))
                    .and_then(|()| std::fs::rename(&tmp, path));
                if let Err(e) = saved {
                    log::warn!("ML 震度模型沒能存到磁碟，下次啟動會再下載：{e}");
                }
                log::info!(
                    "ML 震度模型下載完成：{url}（{}）",
                    trem_core::fmt::fmt_bytes(bytes.len() as u64)
                );
                return Some(bytes.to_vec());
            }
            Ok(_) => log::warn!("{url} 下載的 ML 震度模型 SHA-256 不符，換下一個來源"),
            Err(e) => log::warn!("{url} 下載 ML 震度模型失敗，換下一個來源：{e}"),
        }
    }
    None
}

/// Tests read the repository's copy instead of downloading it.
#[cfg(test)]
pub fn load_for_tests() -> &'static Model {
    const ONNX: &[u8] = include_bytes!("../../assets/models/intensity_ml_v1.onnx");
    assert!(sha256_matches(ONNX), "the model in the repository changed");
    MODEL.get_or_init(|| Model::from_onnx(ONNX).unwrap())
}
