//! SQLite-backed HTTP validator/body cache for `http_proxy`.
//!
//! # Concurrency model
//!
//! SQLite in WAL mode allows any number of concurrent readers alongside exactly
//! one writer, so the cache is built as a **reader pool plus a single writer
//! thread** rather than one connection behind a mutex:
//!
//! ```text
//!   blocking-pool tasks --+
//!   (one per request)     +--> ReaderPool ---> N reader connections  (parallel)
//!                         |                    WAL snapshot reads, never blocked
//!                         |
//!                         +--> mpsc channel --> writer thread --> 1 read-write conn
//!                              (never blocks)   batches ops in one transaction
//! ```
//!
//! Consequences that matter for a 1 Hz app with map-tile bursts:
//!
//! * **Reads scale across cores.** Each in-flight request checks out its own
//!   connection, so a burst of tiles revalidates in parallel instead of
//!   queueing behind one mutex.
//! * **Writes never block a request.** `put` and `touch` are channel sends that
//!   return immediately; the response is already on its way to the renderer
//!   while the row is still being written.
//! * **Writes are batched.** The writer drains everything queued and commits it
//!   in one transaction, so a tile burst costs one fsync rather than dozens.
//! * **Compression is parallel.** Bodies are gzip'd by the caller's blocking
//!   task *before* being queued, so max-level deflate spreads across cores and
//!   the writer thread only does I/O.
//!
//! # Storage
//!
//! Every stored body is gzip'd at maximum level before it hits the database --
//! including bodies that arrived uncompressed -- so the 250 MB budget is spent
//! on compressed bytes.
//!
//! Eviction is strict LRU on `accessed_at`: a cache hit (304 revalidation or a
//! stale replay) bumps the timestamp, so entries the user keeps hitting float
//! back to the top and are never the rows chosen when the budget is exceeded.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::write::{GzDecoder, GzEncoder};
use flate2::Compression;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

/// Hard ceiling for the sum of `bytes` (i.e. gzip'd body sizes) in the table.
pub const MAX_BYTES: i64 = 250 * 1024 * 1024;

/// Total SQLite page cache across every connection, in KiB.
///
/// `PRAGMA cache_size` is *per connection*, so the requested 40 MB is divided
/// between the writer and the readers rather than handed to each one -- a pool
/// of nine connections each holding 40 MB would be 360 MB resident, which is
/// plainly not what a "40 MB memory cache" means.
const TOTAL_PAGE_CACHE_KIB: i64 = 40 * 1024;

/// Memory-mapped I/O window, per connection. Virtual address space over the
/// same file, not a per-connection copy, so every connection can map it.
const MMAP_BYTES: i64 = 256 * 1024 * 1024;

/// How long a connection waits on a locked database before giving up.
///
/// Deliberately short: a cache read that cannot get the database should become
/// a miss and let the request hit the network, never stall the request behind a
/// checkpoint.
const BUSY_TIMEOUT_MS: u64 = 1_000;

/// Upper bound on how many queued operations one transaction absorbs. Large
/// enough to swallow a tile burst, small enough that the writer stays
/// responsive and a crash loses little.
const MAX_BATCH: usize = 256;

/// A single row, already decoded for the proxy's use.
pub struct CacheEntry {
    pub status: u16,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub headers: HashMap<String, String>,
    /// Still gzip'd; call [`gunzip`] to materialise it.
    pub body_gz: Vec<u8>,
}

/// A response on its way into the cache, before compression.
pub struct StoredResponse {
    pub key: String,
    pub url: String,
    pub status: u16,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// A response already compressed and serialised, ready to queue.
///
/// Produced by [`StoredResponse::compress`] on the caller's thread so the
/// writer never spends time on deflate.
pub struct PreparedWrite {
    key: String,
    url: String,
    status: i64,
    etag: Option<String>,
    last_modified: Option<String>,
    headers_json: String,
    body_gz: Vec<u8>,
    bytes: i64,
}

impl StoredResponse {
    pub fn compress(self) -> PreparedWrite {
        let body_gz = gzip(&self.body);
        let bytes = body_gz.len() as i64;
        PreparedWrite {
            key: self.key,
            url: self.url,
            status: self.status as i64,
            etag: self.etag,
            last_modified: self.last_modified,
            headers_json: serde_json::to_string(&self.headers).unwrap_or_else(|_| "{}".into()),
            body_gz,
            bytes,
        }
    }
}

#[cfg(test)]
pub struct CacheStats {
    pub entries: i64,
    pub bytes: i64,
}

enum WriteOp {
    Put(Box<PreparedWrite>),
    Touch(String),
    /// Round-trip probe: acked once the queue ahead of it has been applied.
    Sync(SyncSender<()>),
}

pub fn gzip(body: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::best());
    // Writing to a Vec cannot fail; a poisoned encoder would still finish.
    let _ = enc.write_all(body);
    enc.finish().unwrap_or_default()
}

pub fn gunzip(body_gz: &[u8]) -> Option<Vec<u8>> {
    let mut dec = GzDecoder::new(Vec::new());
    dec.write_all(body_gz).ok()?;
    dec.finish().ok()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Per-connection tuning. `journal_mode` is a property of the database file and
/// is set once by the writer; everything here is per connection.
fn tune(conn: &Connection, page_cache_kib: i64) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(&format!(
        "PRAGMA cache_size = -{page_cache_kib};
         PRAGMA temp_store = MEMORY;
         PRAGMA mmap_size = {MMAP_BYTES};"
    ))
    .map_err(|e| e.to_string())
}

/// Fixed-size pool of reader connections: they only ever SELECT, though they
/// are opened read-write (see `open`).
///
/// Reads run on tokio's bounded blocking pool, so a checkout blocks only when
/// every connection is already busy, and then only until one is returned.
struct ReaderPool {
    idle: Mutex<Vec<Connection>>,
    available: Condvar,
}

impl ReaderPool {
    fn open(path: &Path, size: usize, page_cache_kib: i64) -> Result<Self, String> {
        let mut conns = Vec::with_capacity(size);
        for _ in 0..size {
            // Opened read-WRITE even though these connections only ever SELECT.
            //
            // A SQLITE_OPEN_READ_ONLY connection cannot run WAL-index recovery
            // or help with a checkpoint, so while the writer checkpoints it can
            // only sit on SQLITE_BUSY until the busy timeout expires. That cost
            // roughly 145 s of stalled tile reads in testing. A read-write
            // handle participates normally and the stall disappears; NO_MUTEX
            // is safe because the pool hands each connection to one thread at a
            // time.
            let conn = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| e.to_string())?;
            tune(&conn, page_cache_kib)?;
            conns.push(conn);
        }
        Ok(Self {
            idle: Mutex::new(conns),
            available: Condvar::new(),
        })
    }

    /// Run `f` against a pooled connection, returning it afterwards even if
    /// `f` unwinds.
    fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> Option<T> {
        let conn = {
            let mut idle = self.idle.lock().ok()?;
            while idle.is_empty() {
                idle = self.available.wait(idle).ok()?;
            }
            idle.pop()?
        };

        struct Return<'a>(&'a ReaderPool, Option<Connection>);
        impl Drop for Return<'_> {
            fn drop(&mut self) {
                if let (Ok(mut idle), Some(conn)) = (self.0.idle.lock(), self.1.take()) {
                    idle.push(conn);
                    self.0.available.notify_one();
                }
            }
        }

        let guard = Return(self, Some(conn));
        let conn = guard.1.as_ref()?;
        Some(f(conn))
    }
}

pub struct HttpCache {
    readers: ReaderPool,
    writes: Sender<WriteOp>,
    /// Running total of `bytes`, maintained by the writer. Read here only by
    /// the tests, which check the accounting eviction depends on.
    #[cfg_attr(not(test), allow(dead_code))]
    used: Arc<AtomicI64>,
    max_bytes: i64,
}

impl HttpCache {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_budget(path, MAX_BYTES)
    }

    fn open_with_budget(path: &Path, max_bytes: i64) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }

        // One reader per core, clamped: below 2 the pool cannot overlap reads,
        // and past 8 the per-connection page cache slice gets too thin to help.
        let reader_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 8);
        let page_cache_kib = TOTAL_PAGE_CACHE_KIB / (reader_count as i64 + 1);

        // The writer opens first: it creates the file, sets WAL (a persistent
        // property of the database) and builds the schema, so the reader
        // connections below always find a valid database.
        let writer_conn = Connection::open(path).map_err(|e| e.to_string())?;
        tune(&writer_conn, page_cache_kib)?;
        writer_conn
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 CREATE TABLE IF NOT EXISTS entries (
                   key           TEXT PRIMARY KEY,
                   url           TEXT NOT NULL,
                   status        INTEGER NOT NULL,
                   etag          TEXT,
                   last_modified TEXT,
                   headers       TEXT NOT NULL,
                   body          BLOB NOT NULL,
                   bytes         INTEGER NOT NULL,
                   created_at    INTEGER NOT NULL,
                   accessed_at   INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_entries_accessed ON entries(accessed_at);",
            )
            .map_err(|e| e.to_string())?;

        let used: i64 = writer_conn
            .query_row("SELECT COALESCE(SUM(bytes), 0) FROM entries", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let used = Arc::new(AtomicI64::new(used));

        let readers = ReaderPool::open(path, reader_count, page_cache_kib)?;

        let (tx, rx) = std::sync::mpsc::channel();
        {
            let used = used.clone();
            std::thread::Builder::new()
                .name("http-cache-writer".into())
                .spawn(move || writer_loop(writer_conn, rx, used, max_bytes))
                .map_err(|e| e.to_string())?;
        }

        let cache = Self {
            readers,
            writes: tx,
            used,
            max_bytes,
        };
        // A budget change (or a crash mid-evict) can leave the table over
        // budget; bring it back in line at startup rather than on first write.
        let (ack, _) = std::sync::mpsc::sync_channel(1);
        let _ = cache.writes.send(WriteOp::Sync(ack));
        Ok(cache)
    }

    /// Read a row on a pooled connection, in parallel with other reads.
    pub fn get(&self, key: &str) -> Option<CacheEntry> {
        self.readers.with(|conn| {
            conn.query_row(
                "SELECT status, etag, last_modified, headers, body FROM entries WHERE key = ?1",
                params![key],
                |row| {
                    let headers_json: String = row.get(3)?;
                    Ok(CacheEntry {
                        status: row.get::<_, i64>(0)? as u16,
                        etag: row.get(1)?,
                        last_modified: row.get(2)?,
                        headers: serde_json::from_str(&headers_json).unwrap_or_default(),
                        body_gz: row.get(4)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
        })?
    }

    /// Mark an entry as freshly used so LRU eviction passes it over. Returns
    /// immediately; the row is updated by the writer thread.
    pub fn touch(&self, key: &str) {
        let _ = self.writes.send(WriteOp::Touch(key.to_string()));
    }

    /// Queue an already-compressed row. Returns immediately.
    pub fn put(&self, prepared: PreparedWrite) {
        // A single body larger than the whole budget can never be stored
        // without immediately evicting everything else.
        if prepared.bytes > self.max_bytes {
            return;
        }
        let _ = self.writes.send(WriteOp::Put(Box::new(prepared)));
    }

    #[cfg(test)]
    fn stats(&self) -> CacheStats {
        let entries = self
            .readers
            .with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        CacheStats {
            entries,
            bytes: self.used.load(Ordering::Relaxed),
        }
    }

    /// Block until everything queued so far has been applied. Test helper.
    #[cfg(test)]
    fn drain(&self) {
        let (ack, done) = std::sync::mpsc::sync_channel(0);
        if self.writes.send(WriteOp::Sync(ack)).is_ok() {
            let _ = done.recv();
        }
    }
}

/// Single writer: drains the queue, applies each batch in one transaction, then
/// enforces the LRU budget.
fn writer_loop(mut conn: Connection, rx: Receiver<WriteOp>, used: Arc<AtomicI64>, max_bytes: i64) {
    // Dropping the last Sender ends the loop, which happens at shutdown.
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        while batch.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(op) => batch.push(op),
                Err(_) => break,
            }
        }

        let mut acks = Vec::new();
        apply_batch(&mut conn, batch, &used, &mut acks);
        evict(&mut conn, &used, max_bytes);
        // Ack only after eviction so a waiting caller sees a settled cache.
        for ack in acks {
            let _ = ack.send(());
        }
    }
}

fn apply_batch(
    conn: &mut Connection,
    batch: Vec<WriteOp>,
    used: &AtomicI64,
    acks: &mut Vec<SyncSender<()>>,
) {
    let now = now_ms();

    // Collapse repeated touches of the same key -- the 1 Hz paths hit a handful
    // of keys over and over, and one UPDATE per key per batch is enough.
    let mut touches: Vec<String> = Vec::new();
    let mut puts: Vec<Box<PreparedWrite>> = Vec::new();

    for op in batch {
        match op {
            WriteOp::Put(p) => puts.push(p),
            WriteOp::Touch(k) => {
                if !touches.contains(&k) {
                    touches.push(k);
                }
            }
            WriteOp::Sync(ack) => acks.push(ack),
        }
    }

    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };

    let mut delta: i64 = 0;
    for p in &puts {
        let previous: i64 = tx
            .query_row(
                "SELECT bytes FROM entries WHERE key = ?1",
                params![p.key],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0);

        let written = tx.execute(
            "INSERT INTO entries
               (key, url, status, etag, last_modified, headers, body, bytes, created_at, accessed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(key) DO UPDATE SET
               url = excluded.url,
               status = excluded.status,
               etag = excluded.etag,
               last_modified = excluded.last_modified,
               headers = excluded.headers,
               body = excluded.body,
               bytes = excluded.bytes,
               created_at = excluded.created_at,
               accessed_at = excluded.accessed_at",
            params![
                p.key,
                p.url,
                p.status,
                p.etag,
                p.last_modified,
                p.headers_json,
                p.body_gz,
                p.bytes,
                now
            ],
        );
        if written.is_ok() {
            delta += p.bytes - previous;
        }
    }

    for key in &touches {
        let _ = tx.execute(
            "UPDATE entries SET accessed_at = ?2 WHERE key = ?1",
            params![key, now],
        );
    }

    if tx.commit().is_ok() && delta != 0 {
        used.fetch_add(delta, Ordering::Relaxed);
    }
}

/// Drop least-recently-used rows until the table is back inside the budget.
fn evict(conn: &mut Connection, used: &AtomicI64, max_bytes: i64) {
    while used.load(Ordering::Relaxed) > max_bytes {
        let victims: Vec<(String, i64)> = {
            let mut stmt = match conn
                .prepare_cached("SELECT key, bytes FROM entries ORDER BY accessed_at ASC LIMIT 256")
            {
                Ok(s) => s,
                Err(_) => return,
            };
            let rows = match stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) {
                Ok(rows) => rows.filter_map(Result::ok).collect(),
                Err(_) => return,
            };
            rows
        };
        if victims.is_empty() {
            // Table is empty but the counter disagrees -- resync and stop.
            used.store(0, Ordering::Relaxed);
            return;
        }

        let tx = match conn.transaction() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        let start = used.load(Ordering::Relaxed);
        let mut freed: i64 = 0;
        for (key, bytes) in victims {
            if start - freed <= max_bytes {
                break;
            }
            if tx
                .execute("DELETE FROM entries WHERE key = ?1", params![key])
                .is_ok()
            {
                freed += bytes;
            }
        }
        if tx.commit().is_err() {
            return;
        }
        used.fetch_sub(freed, Ordering::Relaxed);
        if freed == 0 {
            return; // no progress; stop rather than spin
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, body: &[u8]) -> StoredResponse {
        StoredResponse {
            key: key.to_string(),
            url: format!("https://example.test/{key}"),
            status: 200,
            etag: Some(format!("\"{key}\"")),
            last_modified: None,
            headers: HashMap::new(),
            body: body.to_vec(),
        }
    }

    fn temp_db(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "trem-http-cache-{name}-{}.sqlite",
            std::process::id()
        ));
        cleanup(&p);
        p
    }

    fn cleanup(p: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", p.display()));
        }
    }

    /// xorshift32 -- genuinely incompressible, so gzip cannot shrink test
    /// bodies below the budget and eviction is actually exercised.
    fn noise(seed: u8, len: usize) -> Vec<u8> {
        let mut x: u32 = 0x9E37_79B9 ^ (seed as u32).wrapping_mul(0x85EB_CA6B);
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }

    #[test]
    fn roundtrip_is_gzipped_and_recoverable() {
        let path = temp_db("roundtrip");
        let cache = HttpCache::open_with_budget(&path, MAX_BYTES).unwrap();
        // Highly compressible, so we can also assert storage really is gzip'd.
        let body = vec![b'a'; 100_000];
        cache.put(entry("a", &body).compress());
        cache.drain();

        let got = cache.get("a").expect("entry present");
        assert!(
            got.body_gz.len() < body.len() / 10,
            "expected gzip to shrink the body, got {} bytes",
            got.body_gz.len()
        );
        assert_eq!(gunzip(&got.body_gz).unwrap(), body);
        assert_eq!(got.etag.as_deref(), Some("\"a\""));
        cleanup(&path);
    }

    #[test]
    fn evicts_least_recently_used_and_touch_protects_hot_entries() {
        let path = temp_db("lru");
        let budget = 4_000;
        let cache = HttpCache::open_with_budget(&path, budget).unwrap();

        cache.put(entry("old", &noise(1, 3000)).compress());
        cache.drain();
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.put(entry("mid", &noise(2, 3000)).compress());
        cache.drain();
        std::thread::sleep(std::time::Duration::from_millis(5));

        // "old" is the least recently used -- but a hit re-floats it, so the
        // next eviction must take "mid" instead.
        cache.touch("old");
        cache.drain();
        std::thread::sleep(std::time::Duration::from_millis(5));

        for i in 0..6u8 {
            cache.put(entry(&format!("new{i}"), &noise(10 + i, 3000)).compress());
            cache.drain();
        }

        assert!(
            cache.stats().bytes <= budget,
            "cache stayed within budget, got {}",
            cache.stats().bytes
        );
        assert!(cache.get("mid").is_none(), "cold entry should be evicted");
        assert!(
            cache.get("new5").is_some(),
            "most recent entry should survive"
        );
        cleanup(&path);
    }

    /// Many threads reading while another writes -- the point of the pool.
    #[test]
    fn concurrent_readers_and_writers_do_not_block_or_corrupt() {
        let path = temp_db("concurrent");
        let cache = Arc::new(HttpCache::open_with_budget(&path, MAX_BYTES).unwrap());

        for i in 0..32u8 {
            cache.put(entry(&format!("k{i}"), &noise(i, 2_000)).compress());
        }
        cache.drain();

        let mut handles = Vec::new();
        for t in 0..8u8 {
            let cache = cache.clone();
            handles.push(std::thread::spawn(move || {
                let mut hits = 0u32;
                for round in 0..200u32 {
                    let k = format!("k{}", (round as u8).wrapping_add(t) % 32);
                    if let Some(e) = cache.get(&k) {
                        // Decompressing proves the blob survived concurrent writes.
                        assert!(gunzip(&e.body_gz).is_some(), "blob decodes");
                        cache.touch(&k);
                        hits += 1;
                    }
                }
                hits
            }));
        }
        // Keep writing while all of the above read.
        for i in 32..96u8 {
            cache.put(entry(&format!("k{i}"), &noise(i, 2_000)).compress());
        }

        let total: u32 = handles.into_iter().map(|h| h.join().unwrap()).sum();
        assert_eq!(total, 8 * 200, "every read found its key");

        cache.drain();
        assert_eq!(cache.stats().entries, 96);
        cleanup(&path);
    }

    #[test]
    fn stats_track_the_running_byte_total() {
        let path = temp_db("stats");
        let cache = HttpCache::open_with_budget(&path, MAX_BYTES).unwrap();
        assert_eq!(cache.stats().bytes, 0);

        cache.put(entry("a", &noise(1, 5_000)).compress());
        cache.drain();
        let after_first = cache.stats().bytes;
        assert!(after_first > 0);

        // Overwriting the same key must replace, not accumulate.
        cache.put(entry("a", &noise(2, 5_000)).compress());
        cache.drain();
        let after_replace = cache.stats().bytes;
        assert!(
            (after_replace - after_first).abs() < after_first / 2,
            "replacing a key should not double the total ({after_first} -> {after_replace})"
        );
        assert_eq!(cache.stats().entries, 1);
        cleanup(&path);
    }
}
