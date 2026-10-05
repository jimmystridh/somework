use std::{path::Path, str::FromStr, time::Duration};

use futures::future::BoxFuture;
use serde_json::Value;
use somework_core::{Error, ErrorCode};
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow, SqliteSynchronous},
};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub type Tx = Transaction<'static, Sqlite>;

/// Reads and writes use separate pools. All writes share ONE connection: writers queue in async code instead of
/// contending inside SQLite, whose busy handler sleeps in coarse steps and collapses throughput under contention.
#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
    writer: SqlitePool,
}

pub fn db_error(err: sqlx::Error) -> Error {
    match &err {
        sqlx::Error::Database(db) => {
            let msg = db.message().to_string();
            if msg.contains("immutable") || msg.contains("append-only") {
                return Error::new(ErrorCode::TaskTerminal, msg);
            }
            if db.is_unique_violation() {
                return Error::new(ErrorCode::Conflict, format!("unique constraint violated: {msg}"));
            }
            if msg.contains("database is locked") || msg.contains("busy") {
                return Error::unavailable(format!("database busy: {msg}"));
            }
            Error::internal(format!("database error: {msg}"))
        }
        sqlx::Error::PoolTimedOut => Error::unavailable("database pool exhausted"),
        other => Error::internal(format!("database error: {other}")),
    }
}

pub trait DbResultExt<T> {
    fn db(self) -> Result<T, Error>;
}

impl<T> DbResultExt<T> for Result<T, sqlx::Error> {
    fn db(self) -> Result<T, Error> {
        self.map_err(db_error)
    }
}

pub struct DbOptions {
    pub max_connections: u32,
    pub synchronous_full: bool,
    pub busy_timeout: Duration,
}

impl Default for DbOptions {
    fn default() -> Self {
        Self { max_connections: 8, synchronous_full: true, busy_timeout: Duration::from_secs(15) }
    }
}

impl Db {
    pub async fn open(path: &Path, opts: &DbOptions) -> Result<Self, Error> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| Error::internal(format!("create db dir: {e}")))?;
        }
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
            .map_err(db_error)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(if opts.synchronous_full { SqliteSynchronous::Full } else { SqliteSynchronous::Normal })
            .busy_timeout(opts.busy_timeout)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(opts.max_connections)
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(options.clone())
            .await
            .map_err(db_error)?;
        MIGRATOR.run(&pool).await.map_err(|e| Error::internal(format!("migration failed: {e}")))?;
        // A handler future cancelled mid-transaction (client hang-up) can leave the lone writer connection with an open
        // transaction; such a connection is discarded instead of being reused, so the next writer gets a clean one.
        let writer = SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(60))
            .before_acquire(|conn, _meta| {
                Box::pin(async move {
                    use sqlx::Connection as _;
                    Ok(!conn.is_in_transaction())
                })
            })
            .connect_with(options)
            .await
            .map_err(db_error)?;
        Ok(Self { pool, writer })
    }

    /// Read pool (concurrent readers, WAL). Use [`Db::writer`] for any statement that writes.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// The single write connection.
    pub fn writer(&self) -> &SqlitePool {
        &self.writer
    }

    /// Writers take SQLite's write lock up front (`BEGIN IMMEDIATE`) so read-then-write sequences such as task
    /// claims cannot interleave across connections or processes.
    pub async fn begin_write(&self) -> Result<Tx, Error> {
        self.writer.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)
    }

    pub async fn begin_read(&self) -> Result<Tx, Error> {
        self.pool.begin().await.map_err(db_error)
    }

    pub async fn write<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send,
        F: for<'t> FnOnce(&'t mut Tx) -> BoxFuture<'t, Result<T, Error>> + Send,
    {
        let mut tx = self.begin_write().await?;
        match f(&mut tx).await {
            Ok(value) => {
                tx.commit().await.map_err(db_error)?;
                Ok(value)
            }
            Err(err) => {
                let _ = tx.rollback().await;
                Err(err)
            }
        }
    }

    pub async fn checkpoint(&self) -> Result<(), Error> {
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&self.writer).await.db()?;
        Ok(())
    }

    pub async fn close(&self) {
        self.writer.close().await;
        self.pool.close().await;
    }
}

pub fn parse_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

pub fn jcol(row: &SqliteRow, col: &str) -> Value {
    row.try_get::<String, _>(col).map(|s| parse_json(&s)).unwrap_or(Value::Null)
}

pub fn jcol_opt(row: &SqliteRow, col: &str) -> Option<Value> {
    row.try_get::<Option<String>, _>(col).ok().flatten().map(|s| parse_json(&s))
}

pub fn scol(row: &SqliteRow, col: &str) -> String {
    row.try_get::<String, _>(col).unwrap_or_default()
}

pub fn scol_opt(row: &SqliteRow, col: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(col).ok().flatten()
}

pub fn icol(row: &SqliteRow, col: &str) -> i64 {
    row.try_get::<i64, _>(col).unwrap_or_default()
}

pub fn icol_opt(row: &SqliteRow, col: &str) -> Option<i64> {
    row.try_get::<Option<i64>, _>(col).ok().flatten()
}
