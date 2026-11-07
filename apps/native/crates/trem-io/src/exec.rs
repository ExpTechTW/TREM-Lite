//! Where async work runs: tokio's workers on the desktop, the page's own event loop in a
//! browser, which has one thread and futures that are not `Send`.

use std::future::Future;
use std::time::Duration;

/// `Send` where work can move between threads; nothing in a browser, which has one.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSend: Send {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send> MaybeSend for T {}
#[cfg(target_arch = "wasm32")]
pub trait MaybeSend {}
#[cfg(target_arch = "wasm32")]
impl<T> MaybeSend for T {}

/// A spawned task, which can be dropped from the outside.
pub struct Task {
    #[cfg(not(target_arch = "wasm32"))]
    handle: tokio::task::JoinHandle<()>,
    #[cfg(target_arch = "wasm32")]
    handle: futures_util::future::AbortHandle,
}

impl Task {
    pub fn abort(&self) {
        self.handle.abort();
    }
}

/// On the desktop it must be called inside the tokio runtime, as `tokio::spawn` is.
#[cfg(not(target_arch = "wasm32"))]
pub fn spawn(work: impl Future<Output = ()> + Send + 'static) -> Task {
    Task {
        handle: tokio::spawn(work),
    }
}

#[cfg(target_arch = "wasm32")]
pub fn spawn(work: impl Future<Output = ()> + 'static) -> Task {
    let (work, handle) = futures_util::future::abortable(work);
    wasm_bindgen_futures::spawn_local(async move {
        let _ = work.await;
    });
    Task { handle }
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep(d: Duration) {
    tokio::time::sleep(d).await;
}

#[cfg(target_arch = "wasm32")]
pub async fn sleep(d: Duration) {
    let ms = d.as_millis().min(i32::MAX as u128) as i32;
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

/// The work's result, or `Err` once `d` has passed first.
pub async fn timeout<F: Future>(d: Duration, work: F) -> Result<F::Output, ()> {
    match race(work, sleep(d)).await {
        Either::First(out) => Ok(out),
        Either::Second(()) => Err(()),
    }
}

pub enum Either<A, B> {
    First(A),
    Second(B),
}

/// Whichever finishes first; the other is dropped.
pub async fn race<A: Future, B: Future>(a: A, b: B) -> Either<A::Output, B::Output> {
    let (a, b) = (std::pin::pin!(a), std::pin::pin!(b));
    match futures_util::future::select(a, b).await {
        futures_util::future::Either::Left((out, _)) => Either::First(out),
        futures_util::future::Either::Right((out, _)) => Either::Second(out),
    }
}
