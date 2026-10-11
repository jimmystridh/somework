//! Postgres: the only place that knows the schema. Every write that changes what agents are told runs in one transaction under one
//! advisory lock, so numbering stays gapless and "an edit of a catalog entry creates a revision for each agent that uses it" is atomic.

use super::contract::{self, Invalid, Known};
use chrono::{DateTime, Utc};
use fleet_shared::operations::*;
use sqlx::{PgPool, Postgres, Transaction, postgres::PgPoolOptions, types::Json};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

/// The migrations this build knows, in order. A database that has applied a version not in this list is newer than the server.
const MIGRATIONS: &[(i64, &str, &str)] = &[(1, "operations", include_str!("../../migrations/0001_operations.sql"))];

/// Serialises every write that changes setup, catalog, library or limits.
const WRITE_LOCK: i64 = 7001;
const MIGRATION_LOCK: i64 = 7000;

#[derive(Debug)]
pub enum StoreError {
    /// A stale save: the current revision (or version) is this one.
    Conflict(u64),
    InUse(Vec<String>),
    NotFound,
    Invalid(Invalid),
    /// Removing or demoting the last administrator.
    LastAdmin,
    Db(String),
}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        // the text may name tables but never carries the connection string or a value we stored
        Self::Db(error.to_string())
    }
}

impl From<Invalid> for StoreError {
    fn from(invalid: Invalid) -> Self {
        Self::Invalid(invalid)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn number(value: i64) -> u64 {
    value.max(0) as u64
}

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

type Tx<'a> = Transaction<'a, Postgres>;

/// Brings the schema up to this build's version, or refuses when the database is ahead of it.
pub async fn migrate(pool: &PgPool) -> std::result::Result<(), String> {
    let describe = |error: sqlx::Error| format!("database migration failed: {error}");
    let mut connection = pool.acquire().await.map_err(describe)?;
    sqlx::query("SELECT pg_advisory_lock($1)").bind(MIGRATION_LOCK).execute(&mut *connection).await.map_err(describe)?;
    let outcome = async {
        sqlx::query("CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())")
            .execute(&mut *connection)
            .await
            .map_err(describe)?;
        let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version").fetch_all(&mut *connection).await.map_err(describe)?;
        let known: BTreeSet<i64> = MIGRATIONS.iter().map(|(version, _, _)| *version).collect();
        if let Some(unknown) = applied.iter().find(|version| !known.contains(version)) {
            let newest = MIGRATIONS.last().map_or(0, |(version, _, _)| *version);
            return Err(format!("the database schema is at version {unknown}, newer than this server knows (version {newest}): refusing to start; run a newer Operations image"));
        }
        for (version, name, sql) in MIGRATIONS.iter().filter(|(version, _, _)| !applied.contains(version)) {
            let mut tx = sqlx::Connection::begin(&mut *connection).await.map_err(describe)?;
            sqlx::raw_sql(sql).execute(&mut *tx).await.map_err(describe)?;
            sqlx::query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)").bind(version).bind(name).execute(&mut *tx).await.map_err(describe)?;
            tx.commit().await.map_err(describe)?;
        }
        Ok(())
    }
    .await;
    let _ = sqlx::query("SELECT pg_advisory_unlock($1)").bind(MIGRATION_LOCK).execute(&mut *connection).await;
    outcome
}

impl Store {
    pub async fn connect(options: sqlx::postgres::PgConnectOptions) -> std::result::Result<Self, String> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(8))
            .connect_with(options)
            .await
            .map_err(|error| format!("cannot connect to the database: {error}"))?;
        migrate(&pool).await?;
        Ok(Self { pool })
    }

    #[cfg(test)]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    async fn begin(&self) -> Result<Tx<'static>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(WRITE_LOCK).execute(&mut *tx).await?;
        Ok(tx)
    }

    async fn audit_in(tx: &mut Tx<'_>, actor: &str, action: &str, target: &str, detail: &str) -> Result<()> {
        sqlx::query("INSERT INTO audit_log (actor, action, target, detail) VALUES ($1, $2, $3, $4)").bind(actor).bind(action).bind(target).bind(contract::cut(detail, 300)).execute(&mut **tx).await?;
        Ok(())
    }

    pub async fn audit(&self, actor: &str, action: &str, target: &str, detail: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::audit_in(&mut tx, actor, action, target, detail).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Newest first. `before` is an entry id: only older entries are returned.
    pub async fn audit_page(&self, limit: i64, before: Option<i64>) -> Result<AuditPage> {
        let rows: Vec<(i64, DateTime<Utc>, String, String, String, String)> =
            sqlx::query_as("SELECT id, at, actor, action, target, detail FROM audit_log WHERE ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $1").bind(limit.clamp(1, 500)).bind(before).fetch_all(&self.pool).await?;
        Ok(AuditPage { entries: rows.into_iter().map(|(id, at, actor, action, target, detail)| AuditEntry { id: number(id), at: iso(at), actor, action, target, detail }).collect() })
    }

    // ------------------------------------------------------------------------------------------------------------ users

    fn user_view((email, role, added_by, added_at): (String, String, String, DateTime<Utc>)) -> Option<UserView> {
        Some(UserView { email, role: Role::parse(&role)?, added_by, added_at: iso(added_at) })
    }

    pub async fn user(&self, email: &str) -> Result<Option<UserView>> {
        let row: Option<(String, String, String, DateTime<Utc>)> = sqlx::query_as("SELECT email, role, added_by, added_at FROM users WHERE email = $1").bind(email.to_lowercase()).fetch_optional(&self.pool).await?;
        Ok(row.and_then(Self::user_view))
    }

    pub async fn users(&self) -> Result<Vec<UserView>> {
        let rows: Vec<(String, String, String, DateTime<Utc>)> = sqlx::query_as("SELECT email, role, added_by, added_at FROM users ORDER BY email").fetch_all(&self.pool).await?;
        Ok(rows.into_iter().filter_map(Self::user_view).collect())
    }

    /// Adds the first administrator when nobody can sign in yet. Returns whether it did.
    pub async fn ensure_first_admin(&self, email: &str) -> Result<bool> {
        let mut tx = self.begin().await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&mut *tx).await?;
        if count > 0 {
            return Ok(false);
        }
        sqlx::query("INSERT INTO users (email, role, added_by) VALUES ($1, 'admin', 'OPERATIONS_FIRST_ADMIN')").bind(email.to_lowercase()).execute(&mut *tx).await?;
        Self::audit_in(&mut tx, "operations", "user.put", &email.to_lowercase(), "first administrator").await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn put_user(&self, email: &str, role: Role, actor: &str) -> Result<UserView> {
        let email = email.to_lowercase();
        let mut tx = self.begin().await?;
        let current: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE email = $1").bind(&email).fetch_optional(&mut *tx).await?;
        if current.as_deref() == Some("admin") && role != Role::Admin {
            let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE role = 'admin'").fetch_one(&mut *tx).await?;
            if admins <= 1 {
                return Err(StoreError::LastAdmin);
            }
        }
        let row: (String, String, String, DateTime<Utc>) = sqlx::query_as(
            "INSERT INTO users (email, role, added_by) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role RETURNING email, role, added_by, added_at",
        )
        .bind(&email)
        .bind(role.label())
        .bind(actor)
        .fetch_one(&mut *tx)
        .await?;
        Self::audit_in(&mut tx, actor, "user.put", &email, role.label()).await?;
        tx.commit().await?;
        Self::user_view(row).ok_or(StoreError::NotFound)
    }

    pub async fn delete_user(&self, email: &str, actor: &str) -> Result<()> {
        let email = email.to_lowercase();
        let mut tx = self.begin().await?;
        let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE email = $1").bind(&email).fetch_optional(&mut *tx).await?;
        match role.as_deref() {
            None => return Err(StoreError::NotFound),
            Some("admin") => {
                let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE role = 'admin'").fetch_one(&mut *tx).await?;
                if admins <= 1 {
                    return Err(StoreError::LastAdmin);
                }
            }
            Some(_) => {}
        }
        sqlx::query("DELETE FROM users WHERE email = $1").bind(&email).execute(&mut *tx).await?;
        Self::audit_in(&mut tx, actor, "user.delete", &email, "").await?;
        tx.commit().await?;
        Ok(())
    }

    // ------------------------------------------------------------------------------------------------------------ setup

    fn setup_revision((agent, revision, form, note, author, created_at): (String, i64, Json<SetupForm>, String, String, DateTime<Utc>)) -> SetupRevision {
        SetupRevision { agent, revision: number(revision), form: form.0, note, author, created_at: iso(created_at) }
    }

    pub async fn latest_setup(&self, agent: &str) -> Result<Option<SetupRevision>> {
        let row = sqlx::query_as("SELECT agent, revision, form, note, author, created_at FROM agent_setup_revisions WHERE agent = $1 ORDER BY revision DESC LIMIT 1").bind(agent).fetch_optional(&self.pool).await?;
        Ok(row.map(Self::setup_revision))
    }

    /// The latest revision of every agent that has one.
    pub async fn latest_setups(&self) -> Result<BTreeMap<String, SetupRevision>> {
        let rows: Vec<(String, i64, Json<SetupForm>, String, String, DateTime<Utc>)> =
            sqlx::query_as("SELECT DISTINCT ON (agent) agent, revision, form, note, author, created_at FROM agent_setup_revisions ORDER BY agent, revision DESC").fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|row| (row.0.clone(), Self::setup_revision(row))).collect())
    }

    /// Newest first.
    pub async fn setup_revisions(&self, agent: &str, limit: i64) -> Result<Vec<SetupRevision>> {
        let rows: Vec<(String, i64, Json<SetupForm>, String, String, DateTime<Utc>)> =
            sqlx::query_as("SELECT agent, revision, form, note, author, created_at FROM agent_setup_revisions WHERE agent = $1 ORDER BY revision DESC LIMIT $2").bind(agent).bind(limit.clamp(1, 500)).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(Self::setup_revision).collect())
    }

    pub async fn setup_revision_at(&self, agent: &str, revision: u64) -> Result<Option<SetupRevision>> {
        let row = sqlx::query_as("SELECT agent, revision, form, note, author, created_at FROM agent_setup_revisions WHERE agent = $1 AND revision = $2").bind(agent).bind(revision as i64).fetch_optional(&self.pool).await?;
        Ok(row.map(Self::setup_revision))
    }

    async fn known_in(tx: &mut Tx<'_>) -> Result<Known> {
        let library: Vec<String> = sqlx::query_scalar("SELECT name FROM library_skills WHERE deleted_at IS NULL").fetch_all(&mut **tx).await?;
        let catalog: Vec<String> = sqlx::query_scalar("SELECT name FROM catalog_entries WHERE deleted_at IS NULL").fetch_all(&mut **tx).await?;
        Ok(Known { library: library.into_iter().collect(), catalog: catalog.into_iter().collect() })
    }

    async fn current_setup_revision(tx: &mut Tx<'_>, agent: &str) -> Result<i64> {
        Ok(sqlx::query_scalar("SELECT COALESCE(max(revision), 0) FROM agent_setup_revisions WHERE agent = $1").bind(agent).fetch_one(&mut **tx).await?)
    }

    async fn insert_setup(tx: &mut Tx<'_>, agent: &str, revision: i64, form: &SetupForm, note: &str, author: &str) -> Result<SetupRevision> {
        let created: DateTime<Utc> = sqlx::query_scalar("INSERT INTO agent_setup_revisions (agent, revision, form, note, author) VALUES ($1, $2, $3, $4, $5) RETURNING created_at")
            .bind(agent)
            .bind(revision)
            .bind(Json(form))
            .bind(note)
            .bind(author)
            .fetch_one(&mut **tx)
            .await?;
        Ok(SetupRevision { agent: agent.into(), revision: number(revision), form: form.clone(), note: note.into(), author: author.into(), created_at: iso(created) })
    }

    /// Saves a new revision of an agent's setup. `base` must be the current revision (0 when there is none), otherwise `Conflict`.
    /// `action` is what the audit log says (`setup.save`, `setup.reset`, `setup.restore`).
    pub async fn save_setup(&self, agent: &str, base: u64, form: &SetupForm, note: &str, author: &str, action: &str) -> Result<SetupRevision> {
        let mut tx = self.begin().await?;
        let form = contract::check_form(form, &Self::known_in(&mut tx).await?)?;
        let current = Self::current_setup_revision(&mut tx, agent).await?;
        if number(current) != base {
            return Err(StoreError::Conflict(number(current)));
        }
        let saved = Self::insert_setup(&mut tx, agent, current + 1, &form, note, author).await?;
        Self::audit_in(&mut tx, author, action, agent, &format!("revision {}", saved.revision)).await?;
        tx.commit().await?;
        Ok(saved)
    }

    // ----------------------------------------------------------------------------------------------------------- catalog

    fn catalog_view((name, revision, entry, author, at): (String, i64, Option<Json<McpEntry>>, String, DateTime<Utc>), used_by: &BTreeMap<String, Vec<String>>) -> Option<CatalogEntryView> {
        Some(CatalogEntryView { used_by: used_by.get(&name).cloned().unwrap_or_default(), name, revision: number(revision), entry: entry?.0, updated_by: author, updated_at: iso(at) })
    }

    async fn used_by(&self, field: &str) -> Result<BTreeMap<String, Vec<String>>> {
        let setups = self.latest_setups().await?;
        let mut used: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (agent, revision) in setups {
            let names = if field == "mcp" { &revision.form.mcp } else { &revision.form.library_skills };
            for name in names {
                used.entry(name.clone()).or_default().push(contract::slug_of(&agent));
            }
        }
        Ok(used)
    }

    /// Entries that exist now, by name.
    pub async fn catalog(&self) -> Result<Vec<CatalogEntryView>> {
        let used = self.used_by("mcp").await?;
        let rows: Vec<(String, i64, Option<Json<McpEntry>>, String, DateTime<Utc>)> = sqlx::query_as(
            "SELECT DISTINCT ON (r.name) r.name, r.revision, r.entry, r.author, r.created_at FROM catalog_revisions r JOIN catalog_entries e ON e.name = r.name WHERE e.deleted_at IS NULL ORDER BY r.name, r.revision DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().filter_map(|row| Self::catalog_view(row, &used)).collect())
    }

    pub async fn catalog_entry(&self, name: &str) -> Result<Option<CatalogEntryView>> {
        Ok(self.catalog().await?.into_iter().find(|entry| entry.name == name))
    }

    pub async fn catalog_revisions(&self, name: &str, limit: i64) -> Result<Vec<(i64, Option<McpEntry>, String, String, DateTime<Utc>)>> {
        let rows: Vec<(i64, Option<Json<McpEntry>>, String, String, DateTime<Utc>)> =
            sqlx::query_as("SELECT revision, entry, author, note, created_at FROM catalog_revisions WHERE name = $1 ORDER BY revision DESC LIMIT $2").bind(name).bind(limit.clamp(1, 500)).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(revision, entry, author, note, at)| (revision, entry.map(|json| json.0), author, note, at)).collect())
    }

    /// The enabled entries of a form as they are now.
    pub async fn resolve_catalog(&self, names: &[String]) -> Result<BTreeMap<String, McpEntry>> {
        Ok(self.catalog().await?.into_iter().filter(|entry| names.contains(&entry.name)).map(|entry| (entry.name, entry.entry)).collect())
    }

    /// Adds a revision of every agent whose latest setup enables `field` = `name`, in the same transaction as the edit that caused it.
    async fn revise_users_of(tx: &mut Tx<'_>, field: &str, name: &str, note: &str, author: &str) -> Result<Vec<(String, u64)>> {
        let key = if field == "mcp" { "mcp" } else { "librarySkills" };
        let rows: Vec<(String, i64, Json<SetupForm>)> = sqlx::query_as(
            "SELECT agent, revision, form FROM (SELECT DISTINCT ON (agent) agent, revision, form FROM agent_setup_revisions ORDER BY agent, revision DESC) latest WHERE form -> $1::text @> jsonb_build_array($2::text) ORDER BY agent",
        )
        .bind(key)
        .bind(name)
        .fetch_all(&mut **tx)
        .await?;
        let mut revised = Vec::new();
        for (agent, revision, form) in rows {
            let saved = Self::insert_setup(tx, &agent, revision + 1, &form.0, note, author).await?;
            revised.push((agent, saved.revision));
        }
        Ok(revised)
    }

    /// Creates or changes a catalog entry. Returns the new view (or the unchanged one) and the agents that got a new revision.
    pub async fn save_catalog(&self, entry: &McpEntry, base: u64, note: &str, author: &str) -> Result<(CatalogEntryView, Vec<(String, u64)>)> {
        let mut tx = self.begin().await?;
        let current: Option<(i64, Option<Json<McpEntry>>)> = sqlx::query_as("SELECT revision, entry FROM catalog_revisions WHERE name = $1 ORDER BY revision DESC LIMIT 1").bind(&entry.name).fetch_optional(&mut *tx).await?;
        let current_number = current.as_ref().map_or(0, |(revision, _)| *revision);
        if number(current_number) != base {
            return Err(StoreError::Conflict(number(current_number)));
        }
        if let Some((revision, Some(existing))) = &current
            && existing.0 == *entry
        {
            let row: (String, i64, Option<Json<McpEntry>>, String, DateTime<Utc>) =
                sqlx::query_as("SELECT name, revision, entry, author, created_at FROM catalog_revisions WHERE name = $1 AND revision = $2").bind(&entry.name).bind(revision).fetch_one(&mut *tx).await?;
            drop(tx);
            let view = Self::catalog_view(row, &self.used_by("mcp").await?).ok_or(StoreError::NotFound)?;
            return Ok((view, Vec::new()));
        }
        sqlx::query("INSERT INTO catalog_entries (name, created_by) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET deleted_at = NULL").bind(&entry.name).bind(author).execute(&mut *tx).await?;
        let revision = current_number + 1;
        let created: DateTime<Utc> = sqlx::query_scalar("INSERT INTO catalog_revisions (name, revision, entry, note, author) VALUES ($1, $2, $3, $4, $5) RETURNING created_at")
            .bind(&entry.name)
            .bind(revision)
            .bind(Json(entry))
            .bind(note)
            .bind(author)
            .fetch_one(&mut *tx)
            .await?;
        let revised = Self::revise_users_of(&mut tx, "mcp", &entry.name, &format!("catalog entry \"{}\" changed (revision {revision})", entry.name), author).await?;
        Self::audit_in(&mut tx, author, "catalog.put", &entry.name, &format!("revision {revision}; {} agent revisions", revised.len())).await?;
        tx.commit().await?;
        let mut used_by: Vec<String> = revised.iter().map(|(agent, _)| contract::slug_of(agent)).collect();
        used_by.sort();
        let view = CatalogEntryView { name: entry.name.clone(), revision: number(revision), entry: entry.clone(), updated_by: author.into(), updated_at: iso(created), used_by };
        Ok((view, revised))
    }

    pub async fn delete_catalog(&self, name: &str, author: &str) -> Result<()> {
        let mut tx = self.begin().await?;
        let current: Option<(i64, Option<Json<McpEntry>>)> = sqlx::query_as("SELECT revision, entry FROM catalog_revisions WHERE name = $1 ORDER BY revision DESC LIMIT 1").bind(name).fetch_optional(&mut *tx).await?;
        let Some((revision, Some(_))) = current else { return Err(StoreError::NotFound) };
        let users = Self::users_in(&mut tx, "mcp", name).await?;
        if !users.is_empty() {
            return Err(StoreError::InUse(users));
        }
        sqlx::query("INSERT INTO catalog_revisions (name, revision, entry, note, author) VALUES ($1, $2, NULL, 'deleted', $3)").bind(name).bind(revision + 1).bind(author).execute(&mut *tx).await?;
        sqlx::query("UPDATE catalog_entries SET deleted_at = now() WHERE name = $1").bind(name).execute(&mut *tx).await?;
        Self::audit_in(&mut tx, author, "catalog.delete", name, &format!("revision {}", revision + 1)).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn users_in(tx: &mut Tx<'_>, field: &str, name: &str) -> Result<Vec<String>> {
        let key = if field == "mcp" { "mcp" } else { "librarySkills" };
        let agents: Vec<String> = sqlx::query_scalar(
            "SELECT agent FROM (SELECT DISTINCT ON (agent) agent, form FROM agent_setup_revisions ORDER BY agent, revision DESC) latest WHERE form -> $1::text @> jsonb_build_array($2::text) ORDER BY agent",
        )
        .bind(key)
        .bind(name)
        .fetch_all(&mut **tx)
        .await?;
        Ok(agents.iter().map(|agent| contract::slug_of(agent)).collect())
    }

    // ----------------------------------------------------------------------------------------------------------- library

    fn library_view((name, version, _content, description, sha256, size, author, at): LibraryRow, used_by: &BTreeMap<String, Vec<String>>) -> LibrarySkillView {
        LibrarySkillView { used_by: used_by.get(&name).cloned().unwrap_or_default(), name, version: number(version), description, sha256, size_bytes: number(size), updated_by: author, updated_at: iso(at) }
    }

    const LIBRARY_LATEST: &'static str = "SELECT DISTINCT ON (r.name) r.name, r.version, r.content, r.description, r.sha256, r.size_bytes, r.author, r.created_at FROM library_revisions r JOIN library_skills s ON s.name = r.name WHERE s.deleted_at IS NULL";

    pub async fn library(&self) -> Result<Vec<LibrarySkillView>> {
        let used = self.used_by("library").await?;
        let rows: Vec<LibraryRow> = sqlx::query_as(&format!("{} ORDER BY r.name, r.version DESC", Self::LIBRARY_LATEST)).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|row| Self::library_view(row, &used)).collect())
    }

    pub async fn library_skill(&self, name: &str) -> Result<Option<LibrarySkillDetail>> {
        let used = self.used_by("library").await?;
        let row: Option<LibraryRow> = sqlx::query_as(&format!("{} AND r.name = $1 ORDER BY r.name, r.version DESC", Self::LIBRARY_LATEST)).bind(name).fetch_optional(&self.pool).await?;
        Ok(row.map(|row| {
            let content = row.2.clone().unwrap_or_default();
            LibrarySkillDetail { skill: Self::library_view(row, &used), content }
        }))
    }

    /// The enabled skills of a form as the agent receives them.
    pub async fn resolve_library(&self, names: &[String]) -> Result<BTreeMap<String, LibrarySkill>> {
        let rows: Vec<LibraryRow> = sqlx::query_as(&format!("{} AND r.name = ANY($1) ORDER BY r.name, r.version DESC", Self::LIBRARY_LATEST)).bind(names).fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|(name, version, content, description, sha256, _, _, _)| (name.clone(), LibrarySkill { name, version: number(version), description, content: content.unwrap_or_default(), sha256 }))
            .collect())
    }

    pub async fn library_revisions(&self, name: &str, limit: i64) -> Result<Vec<LibraryRevision>> {
        let rows: Vec<(i64, Option<String>, String, String, i64, String, String, DateTime<Utc>)> = sqlx::query_as(
            "SELECT version, content, description, sha256, size_bytes, author, note, created_at FROM library_revisions WHERE name = $1 ORDER BY version DESC LIMIT $2",
        )
        .bind(name)
        .bind(limit.clamp(1, 500) + 1)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::new();
        for (index, (version, content, description, sha256, size, author, note, at)) in rows.iter().enumerate() {
            let previous = rows.get(index + 1).and_then(|row| row.1.as_deref());
            if index as i64 >= limit.clamp(1, 500) {
                break;
            }
            out.push(LibraryRevision {
                name: name.into(),
                version: number(*version),
                content: content.clone(),
                description: description.clone(),
                sha256: sha256.clone(),
                size_bytes: number(*size),
                author: author.clone(),
                note: note.clone(),
                created_at: iso(*at),
                diff: super::diff::diff_content(previous, content.as_deref()),
            });
        }
        Ok(out)
    }

    /// Creates or changes a skill. An unchanged text is not a new version. Returns the view and the agents that got a new revision.
    pub async fn save_library(&self, name: &str, base: u64, skill: &contract::CheckedSkill, note: &str, author: &str) -> Result<(LibrarySkillView, Vec<(String, u64)>)> {
        let mut tx = self.begin().await?;
        let current: Option<(i64, Option<String>)> = sqlx::query_as("SELECT version, content FROM library_revisions WHERE name = $1 ORDER BY version DESC LIMIT 1").bind(name).fetch_optional(&mut *tx).await?;
        let current_number = current.as_ref().map_or(0, |(version, _)| *version);
        if number(current_number) != base {
            return Err(StoreError::Conflict(number(current_number)));
        }
        if let Some((_, Some(existing))) = &current
            && *existing == skill.content
        {
            drop(tx);
            let detail = self.library_skill(name).await?.ok_or(StoreError::NotFound)?;
            return Ok((detail.skill, Vec::new()));
        }
        sqlx::query("INSERT INTO library_skills (name, created_by) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET deleted_at = NULL").bind(name).bind(author).execute(&mut *tx).await?;
        let version = current_number + 1;
        let created: DateTime<Utc> = sqlx::query_scalar(
            "INSERT INTO library_revisions (name, version, content, description, sha256, size_bytes, note, author) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING created_at",
        )
        .bind(name)
        .bind(version)
        .bind(&skill.content)
        .bind(&skill.description)
        .bind(&skill.sha256)
        .bind(skill.size_bytes as i64)
        .bind(note)
        .bind(author)
        .fetch_one(&mut *tx)
        .await?;
        let revised = Self::revise_users_of(&mut tx, "library", name, &format!("library skill \"{name}\" changed (version {version})"), author).await?;
        Self::audit_in(&mut tx, author, "library.put", name, &format!("version {version}; {} agent revisions", revised.len())).await?;
        tx.commit().await?;
        let mut used_by: Vec<String> = revised.iter().map(|(agent, _)| contract::slug_of(agent)).collect();
        used_by.sort();
        let view = LibrarySkillView { name: name.into(), version: number(version), description: skill.description.clone(), sha256: skill.sha256.clone(), size_bytes: skill.size_bytes, updated_by: author.into(), updated_at: iso(created), used_by };
        Ok((view, revised))
    }

    pub async fn delete_library(&self, name: &str, author: &str) -> Result<()> {
        let mut tx = self.begin().await?;
        let current: Option<(i64, Option<String>)> = sqlx::query_as("SELECT version, content FROM library_revisions WHERE name = $1 ORDER BY version DESC LIMIT 1").bind(name).fetch_optional(&mut *tx).await?;
        let Some((version, Some(_))) = current else { return Err(StoreError::NotFound) };
        let users = Self::users_in(&mut tx, "library", name).await?;
        if !users.is_empty() {
            return Err(StoreError::InUse(users));
        }
        sqlx::query("INSERT INTO library_revisions (name, version, content, note, author) VALUES ($1, $2, NULL, 'deleted', $3)").bind(name).bind(version + 1).bind(author).execute(&mut *tx).await?;
        sqlx::query("UPDATE library_skills SET deleted_at = now() WHERE name = $1").bind(name).execute(&mut *tx).await?;
        Self::audit_in(&mut tx, author, "library.delete", name, &format!("version {}", version + 1)).await?;
        tx.commit().await?;
        Ok(())
    }

    // ------------------------------------------------------------------------------------------------------------ limits

    fn limits_revision((revision, limits, note, author, at): (i64, Json<LimitsValues>, String, String, DateTime<Utc>)) -> LimitsRevision {
        LimitsRevision { revision: number(revision), values: limits.0, note, author, created_at: iso(at) }
    }

    pub async fn latest_limits(&self) -> Result<Option<LimitsRevision>> {
        let row = sqlx::query_as("SELECT revision, limits, note, author, created_at FROM fleet_limits_revisions ORDER BY revision DESC LIMIT 1").fetch_optional(&self.pool).await?;
        Ok(row.map(Self::limits_revision))
    }

    /// Newest first.
    pub async fn limits_revisions(&self, limit: i64) -> Result<Vec<LimitsRevision>> {
        let rows: Vec<(i64, Json<LimitsValues>, String, String, DateTime<Utc>)> =
            sqlx::query_as("SELECT revision, limits, note, author, created_at FROM fleet_limits_revisions ORDER BY revision DESC LIMIT $1").bind(limit.clamp(1, 500)).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(Self::limits_revision).collect())
    }

    pub async fn save_limits(&self, base: u64, values: &LimitsValues, note: &str, author: &str) -> Result<LimitsRevision> {
        contract::check_limits(values)?;
        let mut tx = self.begin().await?;
        let current: i64 = sqlx::query_scalar("SELECT COALESCE(max(revision), 0) FROM fleet_limits_revisions").fetch_one(&mut *tx).await?;
        if number(current) != base {
            return Err(StoreError::Conflict(number(current)));
        }
        let row: (i64, Json<LimitsValues>, String, String, DateTime<Utc>) =
            sqlx::query_as("INSERT INTO fleet_limits_revisions (revision, limits, note, author) VALUES ($1, $2, $3, $4) RETURNING revision, limits, note, author, created_at").bind(current + 1).bind(Json(values)).bind(note).bind(author).fetch_one(&mut *tx).await?;
        Self::audit_in(&mut tx, author, "limits.put", "fleet", &format!("revision {}", current + 1)).await?;
        tx.commit().await?;
        Ok(Self::limits_revision(row))
    }

    // ---------------------------------------------------------------------------------------------------------- delivery

    pub async fn delivery_rows(&self) -> Result<Vec<DeliveryRow>> {
        let rows: Vec<DeliveryTuple> = sqlx::query_as(
            "SELECT agent, kind, revision_sent, last_sent_at, last_reported_revision, rejected_revision, rejected_reason, rejected_at, last_error, last_error_at, failures FROM delivery_state",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(agent, kind, sent, sent_at, reported, rejected_revision, rejected_reason, rejected_at, error, error_at, failures)| DeliveryRow {
                agent,
                kind,
                revision_sent: sent.map(number),
                last_sent_at: sent_at,
                last_reported_revision: reported.map(number),
                rejected: rejected_revision.zip(rejected_reason).map(|(revision, reason)| (number(revision), reason, rejected_at)),
                last_error: error,
                last_error_at: error_at,
                failures: failures.max(0) as u64,
            })
            .collect())
    }

    /// The domain accepted revision `revision`: remember it and clear the failure.
    pub async fn record_sent(&self, agent: &str, kind: &str, revision: u64) -> Result<()> {
        sqlx::query(
            "INSERT INTO delivery_state (agent, kind, revision_sent, last_sent_at, failures) VALUES ($1, $2, $3, now(), 0)
             ON CONFLICT (agent, kind) DO UPDATE SET revision_sent = EXCLUDED.revision_sent, last_sent_at = now(), last_error = NULL, last_error_at = NULL, failures = 0",
        )
        .bind(agent)
        .bind(kind)
        .bind(revision as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A send (or the composition of a document) failed: keep the reason where the operator can see it and count the failures in a row.
    pub async fn record_failure(&self, agent: &str, kind: &str, reason: &str) -> Result<u64> {
        let failures: i32 = sqlx::query_scalar(
            "INSERT INTO delivery_state (agent, kind, last_error, last_error_at, failures) VALUES ($1, $2, $3, now(), 1)
             ON CONFLICT (agent, kind) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now(), failures = delivery_state.failures + 1 RETURNING failures",
        )
        .bind(agent)
        .bind(kind)
        .bind(contract::cut(reason, 300))
        .fetch_one(&self.pool)
        .await?;
        Ok(failures.max(0) as u64)
    }

    /// What the agent says it has applied, and the rejection it reports (cleared when it reports none).
    pub async fn record_reported(&self, agent: &str, kind: &str, revision: Option<u64>, rejected: Option<(u64, &str, Option<DateTime<Utc>>)>) -> Result<()> {
        sqlx::query(
            "INSERT INTO delivery_state (agent, kind, last_reported_revision, last_reported_at, rejected_revision, rejected_reason, rejected_at) VALUES ($1, $2, $3, now(), $4, $5, $6)
             ON CONFLICT (agent, kind) DO UPDATE SET last_reported_revision = EXCLUDED.last_reported_revision, last_reported_at = now(),
               rejected_revision = EXCLUDED.rejected_revision, rejected_reason = EXCLUDED.rejected_reason, rejected_at = EXCLUDED.rejected_at",
        )
        .bind(agent)
        .bind(kind)
        .bind(revision.map(|n| n as i64))
        .bind(rejected.map(|(n, _, _)| n as i64))
        .bind(rejected.map(|(_, reason, _)| contract::cut(reason, 300)))
        .bind(rejected.and_then(|(_, _, at)| at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Agents that have anything stored: setup revisions or delivery state.
    pub async fn known_agents(&self) -> Result<BTreeSet<String>> {
        let agents: Vec<String> = sqlx::query_scalar("SELECT agent FROM agent_setup_revisions UNION SELECT agent FROM delivery_state").fetch_all(&self.pool).await?;
        Ok(agents.into_iter().collect())
    }
}

type LibraryRow = (String, i64, Option<String>, String, String, i64, String, DateTime<Utc>);

type DeliveryTuple = (String, String, Option<i64>, Option<DateTime<Utc>>, Option<i64>, Option<i64>, Option<String>, Option<DateTime<Utc>>, Option<String>, Option<DateTime<Utc>>, i32);

#[derive(Clone, Debug)]
pub struct DeliveryRow {
    pub agent: String,
    pub kind: String,
    pub revision_sent: Option<u64>,
    pub last_sent_at: Option<DateTime<Utc>>,
    pub last_reported_revision: Option<u64>,
    /// Revision, reason, when.
    pub rejected: Option<(u64, String, Option<DateTime<Utc>>)>,
    pub last_error: Option<String>,
    pub last_error_at: Option<DateTime<Utc>>,
    pub failures: u64,
}

impl DeliveryRow {
    pub fn view(&self) -> DeliveryView {
        DeliveryView { sent_revision: self.revision_sent, sent_at: self.last_sent_at.map(iso), error: self.last_error.clone(), error_at: self.last_error_at.map(iso), failures: self.failures }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::{contract::check_skill, testing::postgres};

    fn entry(name: &str, command: &str) -> McpEntry {
        McpEntry {
            name: name.into(),
            description: None,
            transport: McpTransport::Stdio,
            command: Some(command.into()),
            args: None,
            env: None,
            url: None,
            headers: None,
            secrets: None,
            approval: McpApproval::Ask,
            downloads: None,
            timeout_seconds: None,
        }
    }

    fn form(mcp: &[&str], library: &[&str]) -> SetupForm {
        SetupForm { mcp: mcp.iter().map(|s| s.to_string()).collect(), library_skills: library.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[tokio::test]
    async fn the_schema_is_created_once_and_a_newer_database_is_refused() {
        let Some(pg) = postgres("the_schema_is_created_once_and_a_newer_database_is_refused") else { return };
        let store = pg.store("schema").await;
        migrate(store.pool()).await.expect("running the migrations again changes nothing");
        let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM schema_migrations").fetch_all(store.pool()).await.unwrap();
        assert_eq!(applied, vec![1]);
        for table in ["users", "agent_setup_revisions", "catalog_entries", "catalog_revisions", "library_skills", "library_revisions", "fleet_limits_revisions", "delivery_state", "audit_log"] {
            let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL").bind(table).fetch_one(store.pool()).await.unwrap();
            assert!(exists, "{table}");
        }
        sqlx::query("INSERT INTO schema_migrations (version, name) VALUES (9999, 'from the future')").execute(store.pool()).await.unwrap();
        let refusal = migrate(store.pool()).await.unwrap_err();
        assert!(refusal.contains("newer than this server knows") && refusal.contains("9999"), "{refusal}");
        let options = crate::ops::database_options(&pg.url("schema"), None, true).unwrap();
        assert!(Store::connect(options).await.err().unwrap().contains("refusing to start"), "connecting refuses too");
    }

    #[tokio::test]
    async fn revisions_and_the_audit_log_cannot_be_rewritten() {
        let Some(pg) = postgres("revisions_and_the_audit_log_cannot_be_rewritten") else { return };
        let store = pg.store("append_only").await;
        store.save_setup("agent/a", 0, &form(&[], &[]), "first", "ed@example.com", "setup.save").await.unwrap();
        for statement in [
            "UPDATE agent_setup_revisions SET note = 'edited'",
            "DELETE FROM agent_setup_revisions",
            "UPDATE audit_log SET actor = 'someone else'",
            "DELETE FROM audit_log",
        ] {
            let error = sqlx::query(statement).execute(store.pool()).await.unwrap_err().to_string();
            assert!(error.contains("append-only"), "{statement}: {error}");
        }
    }

    #[tokio::test]
    async fn setup_revisions_are_numbered_from_one_and_a_stale_save_is_refused() {
        let Some(pg) = postgres("setup_revisions_are_numbered_from_one_and_a_stale_save_is_refused") else { return };
        let store = pg.store("numbering").await;
        assert!(store.latest_setup("agent/a").await.unwrap().is_none());
        let first = store.save_setup("agent/a", 0, &SetupForm { instructions: Some("one".into()), ..Default::default() }, "n1", "ed@example.com", "setup.save").await.unwrap();
        assert_eq!((first.revision, first.author.as_str(), first.note.as_str()), (1, "ed@example.com", "n1"));
        let second = store.save_setup("agent/a", 1, &SetupForm { instructions: Some("two".into()), ..Default::default() }, "", "ed@example.com", "setup.save").await.unwrap();
        assert_eq!(second.revision, 2);
        match store.save_setup("agent/a", 1, &SetupForm { instructions: Some("stale".into()), ..Default::default() }, "", "other@example.com", "setup.save").await {
            Err(StoreError::Conflict(current)) => assert_eq!(current, 2),
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert!(matches!(store.save_setup("agent/a", 0, &SetupForm::default(), "", "x@example.com", "setup.save").await, Err(StoreError::Conflict(2))));
        assert_eq!(store.latest_setup("agent/a").await.unwrap().unwrap().form.instructions.as_deref(), Some("two"), "the stale save changed nothing");
        let log = store.setup_revisions("agent/a", 10).await.unwrap();
        assert_eq!(log.iter().map(|r| r.revision).collect::<Vec<_>>(), vec![2, 1], "newest first");
        assert_eq!(store.setup_revision_at("agent/a", 1).await.unwrap().unwrap().form.instructions.as_deref(), Some("one"));
        assert_eq!(store.save_setup("agent/b", 0, &SetupForm::default(), "", "ed@example.com", "setup.save").await.unwrap().revision, 1, "each agent counts for itself");
    }

    #[tokio::test]
    async fn two_saves_from_the_same_base_cannot_both_win() {
        let Some(pg) = postgres("two_saves_from_the_same_base_cannot_both_win") else { return };
        let store = pg.store("race").await;
        let attempts: Vec<_> = (0..6)
            .map(|index| {
                let store = store.clone();
                tokio::spawn(async move { store.save_setup("agent/a", 0, &SetupForm { instructions: Some(format!("writer {index}")), ..Default::default() }, "", "ed@example.com", "setup.save").await })
            })
            .collect();
        let mut won = 0;
        for attempt in attempts {
            match attempt.await.unwrap() {
                Ok(_) => won += 1,
                Err(StoreError::Conflict(1)) => {}
                Err(other) => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(won, 1, "exactly one writer gets revision 1");
        assert_eq!(store.setup_revisions("agent/a", 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_form_naming_something_that_does_not_exist_is_not_stored() {
        let Some(pg) = postgres("a_form_naming_something_that_does_not_exist_is_not_stored") else { return };
        let store = pg.store("known").await;
        let error = store.save_setup("agent/a", 0, &form(&["ghost"], &[]), "", "ed@example.com", "setup.save").await.unwrap_err();
        assert!(matches!(error, StoreError::Invalid(ref invalid) if invalid.message.contains("no entry ghost")), "{error:?}");
        assert!(store.latest_setup("agent/a").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn editing_a_catalog_entry_revises_each_agent_that_uses_it() {
        let Some(pg) = postgres("editing_a_catalog_entry_revises_each_agent_that_uses_it") else { return };
        let store = pg.store("catalog").await;
        let (view, revised) = store.save_catalog(&entry("docs", "npx"), 0, "", "ed@example.com").await.unwrap();
        assert_eq!((view.revision, revised.len()), (1, 0));
        store.save_catalog(&entry("files", "npx"), 0, "", "ed@example.com").await.unwrap();
        store.save_setup("agent/a", 0, &form(&["docs"], &[]), "", "ed@example.com", "setup.save").await.unwrap();
        store.save_setup("agent/a", 1, &form(&["docs", "files"], &[]), "", "ed@example.com", "setup.save").await.unwrap();
        store.save_setup("agent/b", 0, &form(&["docs"], &[]), "", "ed@example.com", "setup.save").await.unwrap();
        store.save_setup("agent/c", 0, &form(&["files"], &[]), "", "ed@example.com", "setup.save").await.unwrap();
        let (view, revised) = store.save_catalog(&entry("docs", "uvx"), 1, "newer server", "cat@example.com").await.unwrap();
        assert_eq!(view.revision, 2);
        assert_eq!(revised, vec![("agent/a".to_string(), 3), ("agent/b".to_string(), 2)], "a and b use docs, c does not");
        let a = store.latest_setup("agent/a").await.unwrap().unwrap();
        assert_eq!((a.revision, a.author.as_str(), a.note.as_str()), (3, "cat@example.com", "catalog entry \"docs\" changed (revision 2)"));
        assert_eq!(a.form.mcp, vec!["docs", "files"], "the form is carried over unchanged");
        assert_eq!(store.latest_setup("agent/c").await.unwrap().unwrap().revision, 1);
        let unchanged = store.save_catalog(&entry("docs", "uvx"), 2, "", "cat@example.com").await.unwrap();
        assert_eq!((unchanged.0.revision, unchanged.1.len()), (2, 0), "saving the same entry again is no new revision");
        assert!(matches!(store.save_catalog(&entry("docs", "x"), 1, "", "e@x").await, Err(StoreError::Conflict(2))));
        let listed = store.catalog().await.unwrap();
        assert_eq!(listed.iter().map(|e| (e.name.as_str(), e.revision, e.used_by.clone())).collect::<Vec<_>>(), vec![("docs", 2, vec!["a".to_string(), "b".to_string()]), ("files", 1, vec!["a".to_string(), "c".to_string()])]);
    }

    #[tokio::test]
    async fn a_catalog_entry_in_use_cannot_be_deleted_and_a_deleted_one_can_come_back() {
        let Some(pg) = postgres("a_catalog_entry_in_use_cannot_be_deleted_and_a_deleted_one_can_come_back") else { return };
        let store = pg.store("catalog_delete").await;
        store.save_catalog(&entry("docs", "npx"), 0, "", "ed@example.com").await.unwrap();
        store.save_setup("agent/a", 0, &form(&["docs"], &[]), "", "ed@example.com", "setup.save").await.unwrap();
        match store.delete_catalog("docs", "ed@example.com").await {
            Err(StoreError::InUse(users)) => assert_eq!(users, vec!["a"]),
            other => panic!("expected in-use, got {other:?}"),
        }
        store.save_setup("agent/a", 1, &SetupForm::default(), "", "ed@example.com", "setup.save").await.unwrap();
        store.delete_catalog("docs", "ed@example.com").await.unwrap();
        assert!(store.catalog().await.unwrap().is_empty());
        assert!(matches!(store.delete_catalog("docs", "ed@example.com").await, Err(StoreError::NotFound)));
        let revisions = store.catalog_revisions("docs", 10).await.unwrap();
        assert_eq!(revisions.iter().map(|r| (r.0, r.1.is_some())).collect::<Vec<_>>(), vec![(2, false), (1, true)], "history survives the delete");
        let (view, _) = store.save_catalog(&entry("docs", "npx"), 2, "", "ed@example.com").await.unwrap();
        assert_eq!(view.revision, 3, "numbering continues after a delete");
        assert_eq!(store.catalog().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn library_versions_grow_with_every_edit_and_users_get_a_revision() {
        let Some(pg) = postgres("library_versions_grow_with_every_edit_and_users_get_a_revision") else { return };
        let store = pg.store("library").await;
        let v1 = check_skill("review", "---\ndescription: Reviews\n---\nv1").unwrap();
        let (view, revised) = store.save_library("review", 0, &v1, "", "ed@example.com").await.unwrap();
        assert_eq!((view.version, view.description.as_str(), revised.len()), (1, "Reviews", 0));
        store.save_setup("agent/a", 0, &form(&[], &["review"]), "", "ed@example.com", "setup.save").await.unwrap();
        let v2 = check_skill("review", "---\ndescription: Reviews well\n---\nv2").unwrap();
        let (view, revised) = store.save_library("review", 1, &v2, "tighten", "ed@example.com").await.unwrap();
        assert_eq!((view.version, revised), (2, vec![("agent/a".to_string(), 2)]));
        let note = store.latest_setup("agent/a").await.unwrap().unwrap().note;
        assert_eq!(note, "library skill \"review\" changed (version 2)");
        assert!(matches!(store.save_library("review", 1, &v2, "", "ed@example.com").await, Err(StoreError::Conflict(2))));
        let detail = store.library_skill("review").await.unwrap().unwrap();
        assert_eq!((detail.content.as_str(), detail.skill.sha256.as_str(), detail.skill.used_by.clone()), (v2.content.as_str(), v2.sha256.as_str(), vec!["a".to_string()]));
        let resolved = store.resolve_library(&["review".to_string(), "other".to_string()]).await.unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!((resolved["review"].version, resolved["review"].sha256.as_str()), (2, v2.sha256.as_str()));
        let history = store.library_revisions("review", 10).await.unwrap();
        assert_eq!(history.iter().map(|r| r.version).collect::<Vec<_>>(), vec![2, 1]);
        assert!(history[0].diff[0].lines.iter().any(|line| line.op == fleet_shared::operations::LineOp::Add && line.text == "v2"));
        assert!(matches!(store.delete_library("review", "ed@example.com").await, Err(StoreError::InUse(_))));
    }

    #[tokio::test]
    async fn fleet_limits_are_revisions_too() {
        let Some(pg) = postgres("fleet_limits_are_revisions_too") else { return };
        let store = pg.store("limits").await;
        assert!(store.latest_limits().await.unwrap().is_none());
        let values = LimitsValues { max_tokens_cap: 100, max_minutes_cap: 30, daily_token_limit: 1000, budget_raise_ceiling: 200 };
        assert_eq!(store.save_limits(0, &values, "initial", "admin@example.com").await.unwrap().revision, 1);
        let second = store.save_limits(1, &LimitsValues { max_minutes_cap: 45, ..values }, "", "admin@example.com").await.unwrap();
        assert_eq!((second.revision, second.values.max_minutes_cap), (2, 45));
        assert!(matches!(store.save_limits(1, &values, "", "admin@example.com").await, Err(StoreError::Conflict(2))));
        assert!(matches!(store.save_limits(2, &LimitsValues { daily_token_limit: 0, ..values }, "", "a@b").await, Err(StoreError::Invalid(_))));
        assert_eq!(store.limits_revisions(10).await.unwrap().len(), 2);
        assert_eq!(store.latest_limits().await.unwrap().unwrap().revision, 2);
    }

    #[tokio::test]
    async fn the_allow_list_has_a_first_admin_and_never_loses_its_last_one() {
        let Some(pg) = postgres("the_allow_list_has_a_first_admin_and_never_loses_its_last_one") else { return };
        let store = pg.store("users").await;
        assert!(store.ensure_first_admin("First@Example.com").await.unwrap());
        assert!(!store.ensure_first_admin("someone-else@example.com").await.unwrap(), "only when nobody can sign in yet");
        let first = store.user("first@example.com").await.unwrap().unwrap();
        assert_eq!((first.role, first.added_by.as_str()), (Role::Admin, "OPERATIONS_FIRST_ADMIN"));
        assert!(store.user("someone-else@example.com").await.unwrap().is_none());
        store.put_user("Viewer@example.com", Role::Viewer, "first@example.com").await.unwrap();
        assert_eq!(store.user("viewer@example.com").await.unwrap().unwrap().role, Role::Viewer, "emails are lowercase");
        assert!(matches!(store.put_user("first@example.com", Role::Editor, "first@example.com").await, Err(StoreError::LastAdmin)));
        assert!(matches!(store.delete_user("first@example.com", "first@example.com").await, Err(StoreError::LastAdmin)));
        store.put_user("second@example.com", Role::Admin, "first@example.com").await.unwrap();
        store.put_user("first@example.com", Role::Editor, "second@example.com").await.unwrap();
        store.delete_user("viewer@example.com", "second@example.com").await.unwrap();
        assert!(matches!(store.delete_user("viewer@example.com", "second@example.com").await, Err(StoreError::NotFound)));
        assert_eq!(store.users().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn delivery_state_remembers_what_was_sent_what_failed_and_what_the_agent_says() {
        let Some(pg) = postgres("delivery_state_remembers_what_was_sent_what_failed_and_what_the_agent_says") else { return };
        let store = pg.store("delivery").await;
        assert_eq!(store.record_failure("agent/a", "override", &"x".repeat(900)).await.unwrap(), 1);
        assert_eq!(store.record_failure("agent/a", "override", "again").await.unwrap(), 2);
        let row = store.delivery_rows().await.unwrap().remove(0);
        assert_eq!((row.failures, row.last_error.as_deref(), row.revision_sent), (2, Some("again"), None));
        store.record_sent("agent/a", "override", 4).await.unwrap();
        let row = store.delivery_rows().await.unwrap().remove(0);
        assert_eq!((row.failures, row.last_error.clone(), row.revision_sent), (0, None, Some(4)), "a successful send clears the failure");
        store.record_reported("agent/a", "override", Some(3), Some((4, "needs a command", None))).await.unwrap();
        let row = store.delivery_rows().await.unwrap().remove(0);
        assert_eq!((row.last_reported_revision, row.rejected.clone().map(|r| (r.0, r.1))), (Some(3), Some((4, "needs a command".to_string()))));
        store.record_reported("agent/a", "override", Some(4), None).await.unwrap();
        let row = store.delivery_rows().await.unwrap().remove(0);
        assert_eq!((row.last_reported_revision, row.rejected.is_none(), row.revision_sent), (Some(4), true, Some(4)), "the next applied document clears the rejection");
        assert_eq!(store.known_agents().await.unwrap().into_iter().collect::<Vec<_>>(), vec!["agent/a"]);
    }

    #[tokio::test]
    async fn every_write_is_in_the_audit_log_newest_first() {
        let Some(pg) = postgres("every_write_is_in_the_audit_log_newest_first") else { return };
        let store = pg.store("audit").await;
        store.save_catalog(&entry("docs", "npx"), 0, "", "cat@example.com").await.unwrap();
        store.save_setup("agent/a", 0, &form(&["docs"], &[]), "", "ed@example.com", "setup.save").await.unwrap();
        store.save_limits(0, &LimitsValues { max_tokens_cap: 1, max_minutes_cap: 1, daily_token_limit: 1, budget_raise_ceiling: 1 }, "", "admin@example.com").await.unwrap();
        store.put_user("v@example.com", Role::Viewer, "admin@example.com").await.unwrap();
        let page = store.audit_page(10, None).await.unwrap();
        let seen: Vec<(&str, &str, &str)> = page.entries.iter().map(|e| (e.actor.as_str(), e.action.as_str(), e.target.as_str())).collect();
        assert_eq!(seen, vec![("admin@example.com", "user.put", "v@example.com"), ("admin@example.com", "limits.put", "fleet"), ("ed@example.com", "setup.save", "agent/a"), ("cat@example.com", "catalog.put", "docs")]);
        let older = store.audit_page(10, Some(page.entries[1].id as i64)).await.unwrap();
        assert_eq!(older.entries.len(), 2, "paging by id");
        let rejected = store.save_setup("agent/a", 0, &SetupForm::default(), "", "late@example.com", "setup.save").await;
        assert!(rejected.is_err());
        assert_eq!(store.audit_page(10, None).await.unwrap().entries.len(), 4, "a refused save leaves no trace but the refusal");
    }
}
