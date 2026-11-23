//! Local persistence for the workspace graph.
//!
//! SQLite, in the app's data directory. The frontend owns the domain model
//! (`src/lib/types.ts`), so this module deliberately does *not* re-declare it:
//! each row is stored as the JSON the webview already had, and the columns are
//! only the things SQLite genuinely needs to do its job — identity, the one
//! foreign key that drives a cascade, and insertion order.
//!
//! Redeclaring `Chat`, `Message`, `MemoryEntry` and friends as Rust structs
//! would buy nothing but a second source of truth to keep in sync, and would
//! break every time a field was added on the TypeScript side. What this module
//! owns instead is durability: one transaction per patch, foreign keys actually
//! enforced, and a schema version to migrate from.
//!
//! Writes arrive as a *patch* rather than one command per entity. Streaming a
//! turn mutates the same message row many times a second, so the frontend
//! coalesces a burst of changes into a single batch and this side commits it
//! atomically — which is both fewer IPC round-trips and a database that is
//! never caught halfway through a logical change.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};

/// Bumped when the schema changes in a way that needs a migration step.
///
/// 1. `id` + `data` per table, with `messages.chat_id` the only foreign key.
/// 2. Every owned table carries its parent id as a column, so deleting a project
///    cascades to its chats, transcripts, memory, decisions and timeline in one
///    statement instead of five the frontend has to remember to send.
/// 3. Uploaded files: `documents` joins the snapshot tables, and `document_chunks`
///    holds their text *outside* it — see `CHUNKS_SCHEMA`.
/// 4. Workspaces are persisted as the root table, and projects reference them.
/// 5. Embeddings: `vectors` holds one row per retrievable passage, outside the
///    snapshot for the same reason `document_chunks` is — see `VECTORS_SCHEMA`.
/// 6. Attachments: `attachment_blobs` holds the bytes a message was sent with,
///    outside the snapshot for the third time — see `ATTACHMENTS_SCHEMA`.
const SCHEMA_VERSION: i64 = 6;

/// Set once the fixtures have been written, so an empty workspace is
/// distinguishable from one that was never seeded. Without it, a user who
/// deleted their last chat would have the seed data grow back on next launch.
const SEEDED_KEY: &str = "seeded";

/* ---------------------------------------------------------------------- */
/* Schema                                                                  */
/* ---------------------------------------------------------------------- */

/// The document tables, in dependency order.
///
/// Order matters twice. On write, a child row cannot be inserted before its
/// parent exists — a forked chat and its copied transcript arrive in one patch,
/// so `chats` must be written before `messages` or the constraint fires. On
/// delete the order reverses, which is why deletes cascade rather than being
/// issued per table.
const TABLES: &[Table] = &[
    Table {
        name: "workspaces",
        parent: None,
    },
    Table {
        name: "projects",
        parent: Some(WORKSPACE),
    },
    Table {
        name: "chats",
        parent: Some(PROJECT),
    },
    Table {
        name: "messages",
        parent: Some(Parent {
            table: "chats",
            column: "chat_id",
            json_key: "chatId",
        }),
    },
    Table {
        name: "memory",
        parent: Some(PROJECT),
    },
    Table {
        name: "decisions",
        parent: Some(PROJECT),
    },
    Table {
        name: "timeline",
        parent: Some(PROJECT),
    },
    Table {
        name: "documents",
        parent: Some(PROJECT),
    },
];

/// Project-owned tables all carry the project id as a foreign key.
const WORKSPACE: Parent = Parent {
    table: "workspaces",
    column: "workspace_id",
    json_key: "workspaceId",
};

const PROJECT: Parent = Parent {
    table: "projects",
    column: "project_id",
    json_key: "projectId",
};

struct Table {
    name: &'static str,
    /// The owning row, for tables that have one.
    parent: Option<Parent>,
}

#[derive(Clone, Copy)]
struct Parent {
    /// Table the foreign key points at.
    table: &'static str,
    /// Column name in SQLite.
    column: &'static str,
    /// Field to read it out of, in the row's JSON.
    json_key: &'static str,
}

const META_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);";

/// Document text, kept out of the snapshot on purpose.
///
/// Every other table here is read whole at launch, because every view in the app
/// queries across the full graph. Uploaded files are the exception: they are
/// megabytes, and nothing on screen needs their text until retrieval asks for a
/// specific project's. Loading them with everything else would put the cost of
/// every file a user ever uploaded on every launch, forever.
///
/// `project_id` is denormalised from the parent document so the read is one
/// indexed scan rather than a join — chunks are loaded per project, and that is
/// the only query this table serves.
///
/// The foreign key is on `document_id` regardless, because it is what gives the
/// cascade: deleting a document, or the project above it, takes its text with it.
/// Without that, deleting a file would free the row and keep the megabytes.
const CHUNKS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS document_chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  data        TEXT NOT NULL CHECK (json_valid(data))
);";

/// Both accesses this table has, and nothing else.
///
/// The read is `WHERE project_id = ? ORDER BY document_id, position`, so the
/// index covers the filter and both sort keys and the query never sorts. The
/// second index is the cascade's: without it SQLite answers a document delete by
/// scanning every chunk in the workspace once per deleted row.
const CHUNKS_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS document_chunks_project
  ON document_chunks(project_id, document_id, position);
CREATE INDEX IF NOT EXISTS document_chunks_document
  ON document_chunks(document_id);";

/// One embedded passage per row. Kept out of the snapshot, like the chunks.
///
/// The unit is a *passage*, not an entity: a chat is embedded as the paragraphs
/// its messages are made of, a document as the chunks it was split into, and a
/// memory entry or decision as itself. `owner_id` is what a passage belongs to,
/// so deleting one message drops its vectors without a scan of what the row
/// happens to say.
///
/// `model` is stamped on every row because two embedding models share a vector
/// space only by coincidence. Reading rows written by a different one would not
/// fail — it would rank by nonsense, quietly. The read filters on it instead, so
/// changing the model reads as "nothing indexed yet" and the corpus is rebuilt.
///
/// `fingerprint` is a hash of the exact text that was embedded. It is what makes
/// reindexing incremental: a project re-scanned after one new message re-embeds
/// one passage rather than all of them.
///
/// `vector` is base64 of little-endian `f32`, already normalised — see
/// `embeddings::encode`. SQLite never looks inside it; storing it as text rather
/// than a BLOB keeps it opaque on both sides of the IPC boundary and costs about
/// 500 bytes a row over the binary form.
///
/// The foreign key is on the project. It is the only cascade that reaches every
/// kind of passage at once, and without it deleting a project would free its
/// chats and keep their vectors — which are the larger half.
const VECTORS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS vectors (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  model       TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  vector      TEXT NOT NULL
);";

/// The read and the cascade, same as the chunks get.
///
/// The read is `WHERE project_id = ? AND model = ?`, so the index covers both
/// and the model filter costs nothing. The second index is the cascade's:
/// without it, deleting a project scans every vector in the workspace.
const VECTORS_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS vectors_project_model
  ON vectors(project_id, model);
CREATE INDEX IF NOT EXISTS vectors_owner
  ON vectors(owner_id);";

/// The bytes of one attachment. Out of the snapshot, like the chunks.
///
/// The message row itself keeps only what a transcript has to render and what
/// the composer has to price — a name, a MIME type, a size. The base64 payload
/// is here, because a single screenshot is more bytes than a year of somebody's
/// transcripts, and the snapshot is read whole at launch and diffed on every
/// store transition. Folding an image into it would put the cost of every
/// picture ever attached onto every keystroke of every future turn.
///
/// `data` is a `data:` URL, exactly as the provider wants it, and exactly as an
/// `<img src>` wants it — the one representation both consumers already take, so
/// nothing re-encodes it on the way to either.
///
/// Stored as a bare TEXT column rather than as a JSON row, unlike everything
/// else here: it is one opaque string, and wrapping megabytes of base64 in JSON
/// would pay for an escape pass and a parse on both sides of the boundary to
/// carry a field the column already is.
///
/// `chat_id` is denormalised from the owning message so the read is one indexed
/// scan — blobs load per chat, and that is the only query this table serves. The
/// foreign key stays on the message regardless, because it is what gives the
/// cascade: deleting a chat takes its transcript, and its transcript's bytes.
const ATTACHMENTS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS attachment_blobs (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chat_id    TEXT NOT NULL,
  data       TEXT NOT NULL
);";

/// The read and the cascade, same as the other two out-of-snapshot tables get.
const ATTACHMENTS_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS attachment_blobs_chat
  ON attachment_blobs(chat_id);
CREATE INDEX IF NOT EXISTS attachment_blobs_message
  ON attachment_blobs(message_id);";

/// One `CREATE TABLE` per entity: a primary key, an optional parent, and the row
/// itself as JSON.
///
/// Generated from `TABLES` rather than written out, because the same list already
/// drives the reads, the writes and the migration. A hand-maintained DDL block is
/// where the two would drift — a table given a parent in the list but not in the
/// schema would silently lose its cascade, which is exactly the bug that is
/// invisible until someone deletes a project and their chats stay behind.
///
/// `json_valid` is worth the insert-time cost — a malformed row is unreadable
/// forever, and finding out at write time names the culprit while it is still on
/// the stack.
fn tables_ddl() -> String {
    let mut sql = String::from(META_SCHEMA);

    for table in TABLES {
        match &table.parent {
            Some(parent) => sql.push_str(&format!(
                "
CREATE TABLE IF NOT EXISTS {name} (
  id   TEXT PRIMARY KEY,
  {column} TEXT NOT NULL REFERENCES {parent_table}(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK (json_valid(data))
);",
                name = table.name,
                column = parent.column,
                parent_table = parent.table,
            )),
            None => sql.push_str(&format!(
                "
CREATE TABLE IF NOT EXISTS {name} (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data))
);",
                name = table.name,
            )),
        }
    }

    // Last, and after the tables they point at: chunks hang off `documents`,
    // vectors off `projects`, attachment blobs off `messages`.
    sql.push_str(CHUNKS_SCHEMA);
    sql.push_str(VECTORS_SCHEMA);
    sql.push_str(ATTACHMENTS_SCHEMA);

    sql
}

/// An index per foreign key.
///
/// Not optional, and not a micro-optimisation: deleting a project relies on the
/// cascade, and SQLite implements an un-indexed cascade by scanning the entire
/// child table once per deleted parent row. Without these, removing one project
/// would read every message in the workspace.
///
/// Separate from `tables_ddl` because of the order it has to run in. On an
/// existing v1 database the `CREATE TABLE IF NOT EXISTS` above is a no-op — the
/// table is there, in the old shape, without the parent column — so an index on
/// that column can only be created *after* the migration has added it. Emitting
/// both in one batch failed with `no such column` on exactly the databases the
/// migration exists to rescue.
fn indexes_ddl() -> String {
    let mut sql = String::new();
    for table in TABLES {
        if let Some(parent) = &table.parent {
            sql.push_str(&format!(
                "CREATE INDEX IF NOT EXISTS {name}_{column} ON {name}({column});\n",
                name = table.name,
                column = parent.column,
            ));
        }
    }
    sql.push_str(CHUNKS_INDEXES);
    sql.push_str(VECTORS_INDEXES);
    sql.push_str(ATTACHMENTS_INDEXES);
    sql
}

/* ---------------------------------------------------------------------- */
/* Wire types                                                              */
/* ---------------------------------------------------------------------- */

/// The whole workspace, as the frontend holds it in memory anyway.
///
/// Loading everything in one call is the honest shape here: every view in the
/// app queries across the full graph (the timeline replays it by date, search
/// scores all of it), so paginating the load would only mean the frontend
/// re-assembled the same set from more round-trips.
///
/// `RawValue` passes the stored JSON straight through — it was serialised by the
/// webview, and parsing it into a `Value` only to re-serialise it on the way
/// back would double the cost of the one call that runs on every launch.
#[derive(Serialize, Default, Debug)]
pub struct Snapshot {
    pub workspaces: Vec<Box<RawValue>>,
    pub projects: Vec<Box<RawValue>>,
    pub chats: Vec<Box<RawValue>>,
    pub messages: Vec<Box<RawValue>>,
    pub memory: Vec<Box<RawValue>>,
    pub decisions: Vec<Box<RawValue>>,
    pub timeline: Vec<Box<RawValue>>,
    /// Metadata only. The text is in `document_chunks`, which is not read here.
    pub documents: Vec<Box<RawValue>>,
}

impl Snapshot {
    fn slot(&mut self, table: &str) -> &mut Vec<Box<RawValue>> {
        match table {
            "workspaces" => &mut self.workspaces,
            "projects" => &mut self.projects,
            "chats" => &mut self.chats,
            "messages" => &mut self.messages,
            "memory" => &mut self.memory,
            "decisions" => &mut self.decisions,
            "timeline" => &mut self.timeline,
            "documents" => &mut self.documents,
            other => unreachable!("unknown table {other}"),
        }
    }
}

/// A batch of changes: rows to upsert, plus the rows that are gone.
///
/// Four entities can be deleted. Workspaces and projects own others, so their
/// deletes drive cascades. Documents own nothing the frontend holds — but their
/// text does hang off them in `document_chunks`, and a file uploaded by mistake
/// is something a user removes on its own, so it is nameable here.
///
/// Everything else leaves with its parent — a message with its chat, a memory
/// entry or a decision with its project — and the cascade is what removes it, so
/// listing those would mean naming the same delete twice.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    #[serde(default)]
    pub workspaces: Vec<Value>,
    #[serde(default)]
    pub projects: Vec<Value>,
    #[serde(default)]
    pub chats: Vec<Value>,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub memory: Vec<Value>,
    #[serde(default)]
    pub decisions: Vec<Value>,
    #[serde(default)]
    pub timeline: Vec<Value>,
    #[serde(default)]
    pub documents: Vec<Value>,
    #[serde(default)]
    pub deleted_workspaces: Vec<String>,
    #[serde(default)]
    pub deleted_projects: Vec<String>,
    #[serde(default)]
    pub deleted_chats: Vec<String>,
    #[serde(default)]
    pub deleted_documents: Vec<String>,
}

impl Patch {
    fn rows(&self, table: &str) -> &[Value] {
        match table {
            "workspaces" => &self.workspaces,
            "projects" => &self.projects,
            "chats" => &self.chats,
            "messages" => &self.messages,
            "memory" => &self.memory,
            "decisions" => &self.decisions,
            "timeline" => &self.timeline,
            "documents" => &self.documents,
            other => unreachable!("unknown table {other}"),
        }
    }

    /// True when applying this would touch nothing — worth checking before
    /// opening a transaction on every idle tick of the sync loop.
    pub fn is_empty(&self) -> bool {
        self.deleted_workspaces.is_empty()
            && self.deleted_projects.is_empty()
            && self.deleted_chats.is_empty()
            && self.deleted_documents.is_empty()
            && TABLES.iter().all(|t| self.rows(t.name).is_empty())
    }
}

/* ---------------------------------------------------------------------- */
/* Connection                                                             */
/* ---------------------------------------------------------------------- */

/// The open database, shared across commands.
///
/// One connection behind a mutex rather than a pool: writes are serialised by
/// SQLite anyway, and the access pattern here is one snapshot read at launch
/// plus a small patch every few hundred milliseconds.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create the app data directory: {e}"))?;
        }
        let connection =
            Connection::open(&path).map_err(|e| format!("could not open the database: {e}"))?;
        prepare(&connection)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    /// In-memory, for tests.
    #[cfg(test)]
    fn memory() -> Result<Self, String> {
        let connection = Connection::open_in_memory().map_err(|e| e.to_string())?;
        prepare(&connection)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.0.lock().map_err(|_| "database lock poisoned")?;
        f(&mut guard)
    }
}

fn prepare(connection: &Connection) -> Result<(), String> {
    /*
     * WAL keeps the launch-time read from blocking behind an in-flight write, and
     * NORMAL is the right durability trade for a local app: a crash can cost the
     * last commit, never the database.
     *
     * `foreign_keys` is turned explicitly *off* here and back on after the
     * migration, which is SQLite's documented procedure for rebuilding a table.
     * Off is the pragma's default, but relying on that default is what cost the
     * transcripts once already: this build of SQLite is compiled with
     * `SQLITE_DEFAULT_FOREIGN_KEYS=1`, so the `DROP TABLE chats` inside the
     * rebuild cascaded every message away before the replacement table existed to
     * hold them. Stating it leaves nothing to the build's configuration.
     */
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = OFF;",
        )
        .map_err(|e| format!("could not configure the database: {e}"))?;

    connection
        .execute_batch(&tables_ddl())
        .map_err(|e| format!("could not create the schema: {e}"))?;

    // Between the tables and their indexes: a v1 table still lacks the column the
    // index is on until this has rebuilt it.
    migrate(connection)?;

    connection
        .execute_batch(&indexes_ddl())
        .map_err(|e| format!("could not create the indexes: {e}"))?;

    // On per connection, and only now that no table is being rebuilt. Without it
    // the cascades in the schema are decorative.
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("could not enable foreign keys: {e}"))?;

    connection
        .execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| format!("could not stamp the schema version: {e}"))?;

    Ok(())
}

/* ---------------------------------------------------------------------- */
/* Migration                                                               */
/* ---------------------------------------------------------------------- */

/// Bring an older database up to the current shape.
///
/// v1 stored every row as `id` + `data`, with `messages.chat_id` the only foreign
/// key. Four tables now carry their parent id as a column so that deleting a
/// project cascades. `ALTER TABLE ADD COLUMN` cannot add one: SQLite only allows
/// it when the default is NULL, and these are `NOT NULL` and need backfilling
/// from the JSON that is already there. So the tables are rebuilt — SQLite's own
/// prescribed procedure for a schema change it cannot express as an `ALTER`.
///
/// Detection is per table rather than by version number, and that is on purpose:
/// a database interrupted halfway through this — the process killed between two
/// rebuilds — comes back and finishes the remaining ones, where a version stamp
/// would have to be either written too early (losing the rest) or too late
/// (repeating the ones already done).
fn migrate(connection: &Connection) -> Result<(), String> {
    migrate_legacy_workspaces(connection)?;

    for table in TABLES {
        let Some(parent) = &table.parent else {
            continue;
        };
        if has_column(connection, table.name, parent.column)? {
            continue;
        }
        rebuild(connection, table, parent)?;
    }
    Ok(())
}

/// Give legacy projects a parent before rebuilding the projects table.
///
/// Before workspaces became persisted state, SQLite already stored each
/// project's `workspaceId` inside its JSON but had no parent table. The new
/// foreign key cannot be added until those parents exist, so create a neutral
/// metadata row for every referenced id first. The web store replaces the
/// neutral name with a known fixture label when applicable.
fn migrate_legacy_workspaces(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT json_extract(data, '$.workspaceId')
             FROM projects
             WHERE json_extract(data, '$.workspaceId') IS NOT NULL
               AND json_extract(data, '$.workspaceId') <> ''",
        )
        .map_err(|e| format!("could not inspect legacy workspace ids: {e}"))?;

    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("could not read legacy workspace ids: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read a legacy workspace id: {e}"))?;
    drop(statement);

    if ids.is_empty() {
        return Ok(());
    }

    let mut insert = connection
        .prepare(
            "INSERT INTO workspaces (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO NOTHING",
        )
        .map_err(|e| format!("could not prepare legacy workspace migration: {e}"))?;

    for id in ids {
        let data = json!({
            "id": id,
            "name": "Imported workspace",
        })
        .to_string();
        insert
            .execute(params![id, data])
            .map_err(|e| format!("could not migrate legacy workspace {id}: {e}"))?;
    }

    Ok(())
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("could not inspect {table}: {e}"))?;

    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("could not inspect {table}: {e}"))?;

    for name in names {
        if name.map_err(|e| format!("could not inspect {table}: {e}"))? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Copy one table into the current shape, backfilling the parent column.
///
/// In a transaction, so a failure leaves the old table in place rather than a
/// half-copied new one.
fn rebuild(connection: &Connection, table: &Table, parent: &Parent) -> Result<(), String> {
    let name = table.name;
    let column = parent.column;
    let json_key = parent.json_key;
    let parent_table = parent.table;

    /*
     * The `WHERE ... IN (SELECT id FROM parent)` is what makes this safe to run
     * on a real database: a v1 row could point at a parent that no longer exists
     * — a chat whose project was removed from the fixtures between releases —
     * and inserting it would violate the foreign key the rebuild is adding, and
     * fail the whole migration. Such a row is already unreachable in the app, so
     * dropping it loses nothing that was being shown.
     */
    let sql = format!(
        "CREATE TABLE {name}_migrating (
           id   TEXT PRIMARY KEY,
           {column} TEXT NOT NULL REFERENCES {parent_table}(id) ON DELETE CASCADE,
           data TEXT NOT NULL CHECK (json_valid(data))
         );
         INSERT INTO {name}_migrating (id, {column}, data)
           SELECT id, json_extract(data, '$.{json_key}'), data FROM {name}
           WHERE json_extract(data, '$.{json_key}') IN (SELECT id FROM {parent_table})
           ORDER BY rowid;
         DROP TABLE {name};
         ALTER TABLE {name}_migrating RENAME TO {name};
         CREATE INDEX IF NOT EXISTS {name}_{column} ON {name}({column});"
    );

    // `unchecked_transaction` rather than a literal `BEGIN`/`COMMIT` pair: it
    // rolls back when dropped, so a failure part-way through leaves the original
    // table intact instead of an open transaction on a connection we hand back.
    let tx = connection
        .unchecked_transaction()
        .map_err(|e| format!("could not start the {name} migration: {e}"))?;

    tx.execute_batch(&sql)
        .map_err(|e| format!("could not migrate {name}: {e}"))?;

    tx.commit()
        .map_err(|e| format!("could not commit the {name} migration: {e}"))
}

/* ---------------------------------------------------------------------- */
/* Read                                                                    */
/* ---------------------------------------------------------------------- */

/// The stored workspace, or `None` when this database has never been seeded.
///
/// The distinction matters: `None` means "first launch, write the fixtures",
/// while an empty-but-seeded snapshot means "the user deleted everything", and
/// growing the seed data back in that case would be a bug.
pub fn load(db: &Db) -> Result<Option<Snapshot>, String> {
    db.with(|connection| {
        if !seeded(connection)? {
            return Ok(None);
        }

        let mut snapshot = Snapshot::default();
        for table in TABLES {
            // `rowid` is insertion order, which is the transcript's order: the
            // user's message and the assistant placeholder are created in the
            // same millisecond, so `createdAt` cannot separate them. Upserts
            // below use ON CONFLICT rather than INSERT OR REPLACE precisely so
            // that editing a row keeps the rowid it was inserted with.
            let sql = format!("SELECT data FROM {} ORDER BY rowid", table.name);
            let mut statement = connection
                .prepare(&sql)
                .map_err(|e| format!("could not read {}: {e}", table.name))?;

            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("could not read {}: {e}", table.name))?;

            let slot = snapshot.slot(table.name);
            for row in rows {
                let json = row.map_err(|e| format!("could not read {}: {e}", table.name))?;
                // A row that will not parse is corrupt beyond this module's
                // ability to fix. Skipping it loses one entity; failing the
                // whole load would lose the workspace.
                match RawValue::from_string(json) {
                    Ok(raw) => slot.push(raw),
                    Err(_) => continue,
                }
            }
        }

        Ok(Some(snapshot))
    })
}

fn seeded(connection: &Connection) -> Result<bool, String> {
    let found: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![SEEDED_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("could not read the database marker: {e}"))?;
    Ok(found.is_some())
}

/* ---------------------------------------------------------------------- */
/* Write                                                                   */
/* ---------------------------------------------------------------------- */

/// Write the fixtures and mark the database seeded. First launch only.
pub fn seed(db: &Db, patch: &Patch) -> Result<(), String> {
    write(db, patch, true)
}

/// Commit one batch of changes.
pub fn apply(db: &Db, patch: &Patch) -> Result<(), String> {
    if patch.is_empty() {
        return Ok(());
    }
    write(db, patch, false)
}

fn write(db: &Db, patch: &Patch, mark_seeded: bool) -> Result<(), String> {
    db.with(|connection| {
        let tx = connection
            .transaction()
            .map_err(|e| format!("could not start a transaction: {e}"))?;

        /*
         * Deletes first: a patch that both removes a chat and carries a stale
         * upsert for one of its messages would otherwise insert the message and
         * then cascade it away, or trip the foreign key. The frontend drops such
         * rows from the batch as well; this ordering means the database is correct
         * even if it ever forgets to.
         *
         * Projects before chats, because a project's delete cascades *through*
         * chats to their messages. One statement per project id is all it takes —
         * its memory, decisions and timeline are reached by the foreign keys,
         * which is the whole reason those columns exist.
         */
        for (table, ids) in [
            ("projects", &patch.deleted_projects),
            ("chats", &patch.deleted_chats),
            // Last of the three: a document deleted on its own, rather than one
            // the project cascade above has already taken. Either way its chunks
            // go with it — `document_chunks` hangs off this row.
            ("documents", &patch.deleted_documents),
            // A workspace is deleted after its projects so the explicit project
            // cascade and the root cascade never compete with one another.
            ("workspaces", &patch.deleted_workspaces),
        ] {
            if ids.is_empty() {
                continue;
            }
            let mut delete = tx
                .prepare(&format!("DELETE FROM {table} WHERE id = ?1"))
                .map_err(|e| format!("could not prepare the {table} delete: {e}"))?;
            for id in ids {
                delete
                    .execute(params![id])
                    .map_err(|e| format!("could not delete {table} row {id}: {e}"))?;
            }
        }

        for table in TABLES {
            let rows = patch.rows(table.name);
            if rows.is_empty() {
                continue;
            }

            // One prepared statement per table, reused across its rows: the
            // parse and plan happen once for the batch instead of per row.
            let sql = match &table.parent {
                Some(parent) => format!(
                    "INSERT INTO {} (id, {}, data) VALUES (?1, ?2, ?3)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                    table.name, parent.column
                ),
                None => format!(
                    "INSERT INTO {} (id, data) VALUES (?1, ?2)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                    table.name
                ),
            };

            let mut upsert = tx
                .prepare(&sql)
                .map_err(|e| format!("could not prepare the {} upsert: {e}", table.name))?;

            for row in rows {
                let id = field(row, "id")
                    .ok_or_else(|| format!("a {} row arrived without an id", table.name))?;
                let json = serde_json::to_string(row)
                    .map_err(|e| format!("could not serialise a {} row: {e}", table.name))?;

                let result = match &table.parent {
                    Some(parent) => {
                        let owner = field(row, parent.json_key).ok_or_else(|| {
                            format!(
                                "{} row {id} arrived without a {}",
                                table.name, parent.json_key
                            )
                        })?;
                        upsert.execute(params![id, owner, json])
                    }
                    None => upsert.execute(params![id, json]),
                };

                result.map_err(|e| format!("could not save {} row {id}: {e}", table.name))?;
            }
        }

        if mark_seeded {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, '1')
                 ON CONFLICT(key) DO NOTHING",
                params![SEEDED_KEY],
            )
            .map_err(|e| format!("could not mark the database seeded: {e}"))?;
        }

        tx.commit()
            .map_err(|e| format!("could not commit the batch: {e}"))
    })
}

/// A string field out of a row's JSON. The frontend's ids and foreign keys are
/// always strings; anything else is a bug worth surfacing as a missing field.
fn field(row: &Value, key: &str) -> Option<String> {
    row.get(key)?.as_str().map(str::to_owned)
}

/* ---------------------------------------------------------------------- */
/* Document chunks                                                         */
/* ---------------------------------------------------------------------- */

/// Every chunk in one project, in reading order.
///
/// The one query this table serves, and the index is built for it: filter and
/// both sort keys are the index's columns in that order, so SQLite walks it and
/// never sorts. `SELECT data` rather than `*` because the columns beside it exist
/// for the planner, not the caller — the same values are already inside the JSON.
pub fn load_chunks(db: &Db, project_id: &str) -> Result<Vec<Box<RawValue>>, String> {
    db.with(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT data FROM document_chunks
                 WHERE project_id = ?1
                 ORDER BY document_id, position",
            )
            .map_err(|e| format!("could not read the document chunks: {e}"))?;

        let rows = statement
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("could not read the document chunks: {e}"))?;

        let mut chunks = Vec::new();
        for row in rows {
            let json = row.map_err(|e| format!("could not read a document chunk: {e}"))?;
            // Same reasoning as the snapshot: one unparseable chunk costs a
            // paragraph of retrieval, failing the read costs the whole document.
            if let Ok(raw) = RawValue::from_string(json) {
                chunks.push(raw);
            }
        }
        Ok(chunks)
    })
}

/// Replace one document's chunks with the ones given.
///
/// Delete-then-insert rather than upsert, in a single transaction. Re-uploading
/// a file under the same id yields a different number of chunks, and an upsert
/// would leave the tail of the previous version behind as text the document no
/// longer contains — retrievable, quotable, and wrong.
pub fn put_chunks(db: &Db, document_id: &str, chunks: &[Value]) -> Result<(), String> {
    db.with(|connection| {
        let tx = connection
            .transaction()
            .map_err(|e| format!("could not start a transaction: {e}"))?;

        tx.execute(
            "DELETE FROM document_chunks WHERE document_id = ?1",
            params![document_id],
        )
        .map_err(|e| format!("could not clear the chunks of {document_id}: {e}"))?;

        {
            // One prepared statement for the batch: a document is dozens of
            // chunks, and re-planning the insert for each is the whole cost.
            let mut insert = tx
                .prepare(
                    "INSERT INTO document_chunks (id, document_id, project_id, position, data)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| format!("could not prepare the chunk insert: {e}"))?;

            for chunk in chunks {
                let id = field(chunk, "id")
                    .ok_or_else(|| "a document chunk arrived without an id".to_string())?;
                let project_id = field(chunk, "projectId")
                    .ok_or_else(|| format!("document chunk {id} arrived without a projectId"))?;
                let position = chunk
                    .get("index")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| format!("document chunk {id} arrived without an index"))?;
                let json = serde_json::to_string(chunk)
                    .map_err(|e| format!("could not serialise document chunk {id}: {e}"))?;

                insert
                    .execute(params![id, document_id, project_id, position, json])
                    .map_err(|e| format!("could not save document chunk {id}: {e}"))?;
            }
        }

        tx.commit()
            .map_err(|e| format!("could not commit the document chunks: {e}"))
    })
}

/* ---------------------------------------------------------------------- */
/* Vectors                                                                 */
/* ---------------------------------------------------------------------- */

/// One embedded passage, as both sides of the IPC boundary hold it.
///
/// Declared as a struct rather than passed through as opaque JSON — unlike the
/// snapshot rows, this shape is owned here: `model` and `project_id` are read by
/// the query, and `vector` is produced by `embeddings.rs` on this side of the
/// wall. `src/lib/persistence/types.ts` mirrors it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredVector {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub owner_id: String,
    pub model: String,
    pub fingerprint: String,
    /// Base64, little-endian `f32`, unit length. See `embeddings::encode`.
    pub vector: String,
}

/// Every vector in one project that the given model wrote.
///
/// The model filter is the whole reason `model` is a column: rows left by a
/// previous model are not wrong so much as meaningless — they answer distances
/// in a space this one does not share — and a read that returned them would rank
/// by noise rather than fail. Filtered out, they read as "not indexed yet",
/// which is a state the frontend already knows how to recover from.
pub fn load_vectors(db: &Db, project_id: &str, model: &str) -> Result<Vec<StoredVector>, String> {
    db.with(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT id, project_id, kind, owner_id, model, fingerprint, vector
                 FROM vectors
                 WHERE project_id = ?1 AND model = ?2",
            )
            .map_err(|e| format!("could not read the vectors: {e}"))?;

        let rows = statement
            .query_map(params![project_id, model], |row| {
                Ok(StoredVector {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    kind: row.get(2)?,
                    owner_id: row.get(3)?,
                    model: row.get(4)?,
                    fingerprint: row.get(5)?,
                    vector: row.get(6)?,
                })
            })
            .map_err(|e| format!("could not read the vectors: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("could not read a vector: {e}"))
    })
}

/// Upsert a batch of vectors.
///
/// Upsert rather than delete-then-insert, which is the opposite of what
/// `put_chunks` does, and for a reason that is worth naming: a document's chunks
/// are rewritten *as a set* when the file changes, so the previous set has to go.
/// Vectors are written incrementally — a project rescanned after one new message
/// sends one row — so clearing anything not in the batch would delete the whole
/// index on every tick. What is genuinely stale is named by `drop_vectors`.
pub fn put_vectors(db: &Db, vectors: &[StoredVector]) -> Result<(), String> {
    if vectors.is_empty() {
        return Ok(());
    }

    db.with(|connection| {
        let tx = connection
            .transaction()
            .map_err(|e| format!("could not start a transaction: {e}"))?;

        {
            let mut upsert = tx
                .prepare(
                    "INSERT INTO vectors
                       (id, project_id, kind, owner_id, model, fingerprint, vector)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                       fingerprint = excluded.fingerprint,
                       vector      = excluded.vector,
                       model       = excluded.model",
                )
                .map_err(|e| format!("could not prepare the vector upsert: {e}"))?;

            for vector in vectors {
                upsert
                    .execute(params![
                        vector.id,
                        vector.project_id,
                        vector.kind,
                        vector.owner_id,
                        vector.model,
                        vector.fingerprint,
                        vector.vector,
                    ])
                    // A vector for a project that is gone violates the foreign
                    // key, and that is the correct outcome: the reindex it came
                    // from was scanning a workspace the user has since changed.
                    .map_err(|e| format!("could not save vector {}: {e}", vector.id))?;
            }
        }

        tx.commit()
            .map_err(|e| format!("could not commit the vectors: {e}"))
    })
}

/// Forget vectors by id — a passage that no longer exists, or one whose text
/// changed shape enough that its old ids do not line up.
///
/// The cascades cover the coarse cases (a project, and through it every passage
/// under it). This is for the fine ones the database cannot see: a message
/// edited into fewer paragraphs, a document re-uploaded shorter. Nothing points
/// at those rows any more, and left behind they are retrievable text the
/// workspace no longer contains.
pub fn drop_vectors(db: &Db, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    db.with(|connection| {
        let tx = connection
            .transaction()
            .map_err(|e| format!("could not start a transaction: {e}"))?;

        {
            let mut delete = tx
                .prepare("DELETE FROM vectors WHERE id = ?1")
                .map_err(|e| format!("could not prepare the vector delete: {e}"))?;
            for id in ids {
                delete
                    .execute(params![id])
                    .map_err(|e| format!("could not delete vector {id}: {e}"))?;
            }
        }

        tx.commit()
            .map_err(|e| format!("could not commit the vector deletes: {e}"))
    })
}

/* ---------------------------------------------------------------------- */
/* Attachment blobs                                                        */
/* ---------------------------------------------------------------------- */

/// One attachment's bytes, as both sides of the IPC boundary hold it.
///
/// A struct rather than opaque JSON, like `StoredVector` and unlike the snapshot
/// rows: every field here is read by the query or by SQLite itself, and the
/// payload is a plain string rather than a shape the frontend owns.
/// `src/lib/persistence/types.ts` mirrors it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub id: String,
    pub message_id: String,
    /// Denormalised from the message so blobs load per chat in one indexed scan.
    pub chat_id: String,
    /// A `data:` URL — `data:image/png;base64,…`. See `ATTACHMENTS_SCHEMA`.
    pub data: String,
}

/// Every attachment in one chat.
///
/// The only query this table serves, and the index covers it exactly. Ordered by
/// `rowid`, which is the order they were attached in — the same order the
/// message's own metadata lists them, so the two line up without a sort.
pub fn load_attachments(db: &Db, chat_id: &str) -> Result<Vec<StoredAttachment>, String> {
    db.with(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT id, message_id, chat_id, data FROM attachment_blobs
                 WHERE chat_id = ?1
                 ORDER BY rowid",
            )
            .map_err(|e| format!("could not read the attachments: {e}"))?;

        let rows = statement
            .query_map(params![chat_id], |row| {
                Ok(StoredAttachment {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    chat_id: row.get(2)?,
                    data: row.get(3)?,
                })
            })
            .map_err(|e| format!("could not read the attachments: {e}"))?;

        let mut attachments = Vec::new();
        for row in rows {
            attachments.push(row.map_err(|e| format!("could not read an attachment: {e}"))?);
        }
        Ok(attachments)
    })
}

/// Write a batch of attachments.
///
/// Upsert rather than delete-then-insert, which is the opposite of what
/// `put_chunks` does — and for the opposite reason. A document re-uploaded under
/// one id yields a different set of chunks, so the old ones have to go.
/// Attachments are immutable once sent: an id names one file's bytes forever, so
/// a re-send of the same batch is genuinely a no-op and clearing anything not
/// named in it would delete the rest of the message's attachments.
pub fn put_attachments(db: &Db, attachments: &[StoredAttachment]) -> Result<(), String> {
    if attachments.is_empty() {
        return Ok(());
    }

    db.with(|connection| {
        let tx = connection
            .transaction()
            .map_err(|e| format!("could not start a transaction: {e}"))?;

        {
            let mut upsert = tx
                .prepare(
                    "INSERT INTO attachment_blobs (id, message_id, chat_id, data)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                )
                .map_err(|e| format!("could not prepare the attachment insert: {e}"))?;

            for attachment in attachments {
                upsert
                    .execute(params![
                        attachment.id,
                        attachment.message_id,
                        attachment.chat_id,
                        attachment.data
                    ])
                    .map_err(|e| format!("could not save attachment {}: {e}", attachment.id))?;
            }
        }

        tx.commit()
            .map_err(|e| format!("could not commit the attachments: {e}"))
    })
}

/* ---------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace(id: &str, name: &str) -> Value {
        json!({ "id": id, "name": name })
    }

    fn project(id: &str, name: &str) -> Value {
        json!({ "id": id, "workspaceId": "ws-1", "name": name, "instructions": "brief" })
    }

    fn chat_in(project_id: &str, id: &str, title: &str) -> Value {
        json!({ "id": id, "projectId": project_id, "title": title, "modelId": "m" })
    }

    fn chat(id: &str, title: &str) -> Value {
        chat_in("p-1", id, title)
    }

    fn message(id: &str, chat_id: &str, content: &str) -> Value {
        json!({ "id": id, "chatId": chat_id, "role": "user", "content": content })
    }

    fn owned(table: &str, id: &str, project_id: &str) -> Value {
        json!({ "id": id, "projectId": project_id, "title": format!("{table} {id}") })
    }

    /// A patch whose chats all belong to `p-1`, which it also creates.
    ///
    /// Every chat needs a project now, so the fixture supplies one rather than
    /// each test remembering to — the constraint being tested is the cascade, not
    /// the caller's diligence.
    fn patch(chats: Vec<Value>, messages: Vec<Value>) -> Patch {
        Patch {
            workspaces: vec![workspace("ws-1", "One")],
            projects: vec![project("p-1", "One")],
            chats,
            messages,
            ..Default::default()
        }
    }

    #[test]
    fn an_unseeded_database_reads_as_nothing_stored() {
        let db = Db::memory().unwrap();
        assert!(load(&db).unwrap().is_none());
    }

    #[test]
    fn a_seeded_but_emptied_database_stays_seeded() {
        let db = Db::memory().unwrap();
        seed(&db, &patch(vec![chat("c-1", "One")], vec![])).unwrap();

        apply(
            &db,
            &Patch {
                deleted_chats: vec!["c-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        // Seeding again would resurrect fixtures the user deliberately removed.
        let snapshot = load(&db).unwrap().expect("still seeded");
        assert!(snapshot.chats.is_empty());
    }

    #[test]
    fn deleting_a_chat_takes_its_messages_with_it() {
        let db = Db::memory().unwrap();
        seed(
            &db,
            &patch(
                vec![chat("c-1", "One"), chat("c-2", "Two")],
                vec![
                    message("m-1", "c-1", "first"),
                    message("m-2", "c-1", "second"),
                    message("m-3", "c-2", "other"),
                ],
            ),
        )
        .unwrap();

        apply(
            &db,
            &Patch {
                deleted_chats: vec!["c-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.chats.len(), 1);
        // The cascade is only live because `PRAGMA foreign_keys` is set per
        // connection — this asserts the pragma, not just the schema.
        assert_eq!(snapshot.messages.len(), 1);
        assert!(snapshot.messages[0].get().contains("m-3"));
    }

    #[test]
    fn an_upsert_keeps_transcript_order() {
        let db = Db::memory().unwrap();
        seed(
            &db,
            &patch(
                vec![chat("c-1", "One")],
                vec![message("m-1", "c-1", "prompt"), message("m-2", "c-1", "")],
            ),
        )
        .unwrap();

        // What streaming does: the assistant placeholder is rewritten many
        // times after the user's message already exists. INSERT OR REPLACE
        // would move it to the end of the table and reorder the transcript.
        for text in ["par", "partial", "partial answer"] {
            apply(&db, &patch(vec![], vec![message("m-2", "c-1", text)])).unwrap();
        }

        let snapshot = load(&db).unwrap().unwrap();
        let order: Vec<&str> = snapshot
            .messages
            .iter()
            .map(|m| {
                if m.get().contains("m-1") {
                    "m-1"
                } else {
                    "m-2"
                }
            })
            .collect();
        assert_eq!(order, vec!["m-1", "m-2"]);
        assert!(snapshot.messages[1].get().contains("partial answer"));
    }

    #[test]
    fn a_fork_lands_parent_first_in_one_patch() {
        let db = Db::memory().unwrap();
        seed(&db, &patch(vec![chat("c-1", "One")], vec![])).unwrap();

        // Forking creates the chat and copies the transcript in a single store
        // update, so both reach the database in one batch. The foreign key only
        // holds if `chats` is written before `messages`.
        apply(
            &db,
            &patch(
                vec![chat("c-2", "One (fork)")],
                vec![message("m-9", "c-2", "carried")],
            ),
        )
        .unwrap();

        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.chats.len(), 2);
        assert_eq!(snapshot.messages.len(), 1);
    }

    #[test]
    fn a_failed_row_rolls_the_whole_batch_back() {
        let db = Db::memory().unwrap();
        seed(&db, &patch(vec![chat("c-1", "One")], vec![])).unwrap();

        // A message for a chat that does not exist violates the foreign key.
        let result = apply(
            &db,
            &patch(
                vec![chat("c-2", "Two")],
                vec![message("m-1", "c-missing", "orphan")],
            ),
        );

        assert!(result.is_err());
        let snapshot = load(&db).unwrap().unwrap();
        // The valid chat in the same patch must not have survived on its own.
        assert_eq!(snapshot.chats.len(), 1);
    }

    #[test]
    fn an_empty_patch_is_a_no_op() {
        let db = Db::memory().unwrap();
        seed(&db, &patch(vec![chat("c-1", "One")], vec![])).unwrap();
        apply(&db, &Patch::default()).unwrap();
        assert_eq!(load(&db).unwrap().unwrap().chats.len(), 1);
    }

    #[test]
    fn a_row_without_an_id_is_reported_not_silently_dropped() {
        let db = Db::memory().unwrap();
        seed(&db, &Patch::default()).unwrap();

        let result = apply(&db, &patch(vec![json!({ "title": "nameless" })], vec![]));
        assert!(result.unwrap_err().contains("without an id"));
    }

    /* ---- the project cascade ------------------------------------------ */

    #[test]
    fn deleting_a_project_takes_everything_it_owns() {
        let db = Db::memory().unwrap();
        seed(
            &db,
            &Patch {
                workspaces: vec![workspace("ws-1", "One")],
                projects: vec![project("p-1", "One"), project("p-2", "Two")],
                chats: vec![
                    chat_in("p-1", "c-1", "First"),
                    chat_in("p-1", "c-2", "Second"),
                    chat_in("p-2", "c-3", "Other"),
                ],
                messages: vec![
                    message("m-1", "c-1", "one"),
                    message("m-2", "c-2", "two"),
                    message("m-3", "c-3", "three"),
                ],
                memory: vec![
                    owned("memory", "mem-1", "p-1"),
                    owned("memory", "mem-2", "p-2"),
                ],
                decisions: vec![owned("decisions", "dec-1", "p-1")],
                timeline: vec![
                    owned("timeline", "t-1", "p-1"),
                    owned("timeline", "t-2", "p-2"),
                ],
                ..Default::default()
            },
        )
        .unwrap();

        // One id, five tables. If any of the foreign keys or their `ON DELETE
        // CASCADE` were missing, the rows below would still be here.
        apply(
            &db,
            &Patch {
                deleted_projects: vec!["p-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.chats.len(), 1);
        // The two-level hop: messages hang off chats, not off the project, so
        // this is the assertion that proves the cascade chained rather than
        // stopping at the first level.
        assert_eq!(snapshot.messages.len(), 1);
        assert!(snapshot.messages[0].get().contains("m-3"));
        assert_eq!(snapshot.memory.len(), 1);
        assert!(snapshot.memory[0].get().contains("mem-2"));
        assert_eq!(snapshot.decisions.len(), 0);
        assert_eq!(snapshot.timeline.len(), 1);
    }

    #[test]
    fn a_project_and_its_first_chat_land_parent_first_in_one_patch() {
        let db = Db::memory().unwrap();
        seed(&db, &Patch::default()).unwrap();

        // What creating a project and sending its first message produces: a new
        // project, a new chat and two messages in one batch. Only holds if the
        // tables are written in dependency order.
        apply(
            &db,
            &Patch {
                workspaces: vec![workspace("ws-1", "One")],
                projects: vec![project("p-9", "Fresh")],
                chats: vec![chat_in("p-9", "c-9", "First")],
                messages: vec![message("m-9", "c-9", "hello")],
                ..Default::default()
            },
        )
        .unwrap();

        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.chats.len(), 1);
        assert_eq!(snapshot.messages.len(), 1);
    }

    #[test]
    fn a_chat_for_a_project_that_does_not_exist_is_refused() {
        let db = Db::memory().unwrap();
        seed(&db, &Patch::default()).unwrap();

        // The store guards against this by refusing to open a chat with no
        // project selected. This is the second line of that defence.
        let result = apply(
            &db,
            &Patch {
                chats: vec![chat_in("p-missing", "c-1", "Orphan")],
                ..Default::default()
            },
        );

        assert!(result.unwrap_err().contains("FOREIGN KEY"));
    }

    #[test]
    fn deleting_a_project_and_one_of_its_chats_in_one_patch_is_not_an_error() {
        let db = Db::memory().unwrap();
        seed(
            &db,
            &Patch {
                workspaces: vec![workspace("ws-1", "One")],
                projects: vec![project("p-1", "One")],
                chats: vec![chat_in("p-1", "c-1", "First")],
                ..Default::default()
            },
        )
        .unwrap();

        // The frontend drops the redundant chat delete, but a `DELETE` for a row
        // the cascade already removed is a no-op rather than a failure — so the
        // database stays correct even if the diff ever stops filtering.
        apply(
            &db,
            &Patch {
                deleted_projects: vec!["p-1".into()],
                deleted_chats: vec!["c-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.projects.len(), 0);
        assert_eq!(snapshot.chats.len(), 0);
    }

    /* ---- migration ----------------------------------------------------- */

    /// A database in the v1 shape: `id` + `data`, and no parent columns except
    /// `messages.chat_id`.
    fn v1_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                 CREATE TABLE chats (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                 CREATE TABLE messages (
                   id TEXT PRIMARY KEY,
                   chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                   data TEXT NOT NULL
                 );
                 CREATE TABLE memory (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                 CREATE TABLE decisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                 CREATE TABLE timeline (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                 INSERT INTO meta (key, value) VALUES ('seeded', '1');",
            )
            .unwrap();
        connection
    }

    fn insert_v1(connection: &Connection, table: &str, row: &Value) {
        let id = row.get("id").unwrap().as_str().unwrap();
        connection
            .execute(
                &format!("INSERT INTO {table} (id, data) VALUES (?1, ?2)"),
                params![id, row.to_string()],
            )
            .unwrap();
    }

    #[test]
    fn migrating_a_v1_database_backfills_the_parent_columns() {
        let connection = v1_database();
        insert_v1(&connection, "projects", &project("p-1", "One"));
        insert_v1(&connection, "chats", &chat_in("p-1", "c-1", "First"));
        insert_v1(&connection, "memory", &owned("memory", "mem-1", "p-1"));
        insert_v1(
            &connection,
            "decisions",
            &owned("decisions", "dec-1", "p-1"),
        );
        insert_v1(&connection, "timeline", &owned("timeline", "t-1", "p-1"));
        connection
            .execute(
                "INSERT INTO messages (id, chat_id, data) VALUES ('m-1', 'c-1', ?1)",
                params![message("m-1", "c-1", "hello").to_string()],
            )
            .unwrap();

        prepare(&connection).unwrap();
        let db = Db(Arc::new(Mutex::new(connection)));

        // Nothing lost in the copy.
        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.chats.len(), 1);
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.memory.len(), 1);

        // And the cascade the migration existed to enable actually works now.
        apply(
            &db,
            &Patch {
                deleted_projects: vec!["p-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        let after = load(&db).unwrap().unwrap();
        assert_eq!(after.chats.len(), 0);
        assert_eq!(after.messages.len(), 0);
        assert_eq!(after.memory.len(), 0);
        assert_eq!(after.decisions.len(), 0);
        assert_eq!(after.timeline.len(), 0);
    }

    #[test]
    fn migrating_preserves_transcript_order() {
        let connection = v1_database();
        insert_v1(&connection, "projects", &project("p-1", "One"));
        insert_v1(&connection, "chats", &chat_in("p-1", "c-1", "First"));
        for (id, body) in [("m-1", "prompt"), ("m-2", "answer"), ("m-3", "follow up")] {
            connection
                .execute(
                    "INSERT INTO messages (id, chat_id, data) VALUES (?1, 'c-1', ?2)",
                    params![id, message(id, "c-1", body).to_string()],
                )
                .unwrap();
        }

        prepare(&connection).unwrap();
        let db = Db(Arc::new(Mutex::new(connection)));

        // The load orders by rowid, and the rebuild assigns new ones — so the
        // copy has to be ordered or a migrated transcript comes back shuffled.
        let snapshot = load(&db).unwrap().unwrap();
        let ids: Vec<bool> = ["m-1", "m-2", "m-3"]
            .iter()
            .zip(&snapshot.messages)
            .map(|(id, row)| row.get().contains(id))
            .collect();
        assert_eq!(ids, vec![true, true, true]);
    }

    #[test]
    fn migrating_drops_rows_whose_parent_is_already_gone() {
        let connection = v1_database();
        insert_v1(&connection, "projects", &project("p-1", "One"));
        insert_v1(&connection, "chats", &chat_in("p-1", "c-1", "Kept"));
        // v1 had no constraint, so a chat could outlive its project. Carrying it
        // over would violate the foreign key and fail the whole migration, and it
        // was already unreachable in the app.
        insert_v1(&connection, "chats", &chat_in("p-gone", "c-2", "Orphan"));

        prepare(&connection).unwrap();
        let db = Db(Arc::new(Mutex::new(connection)));

        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.chats.len(), 1);
        assert!(snapshot.chats[0].get().contains("c-1"));
    }

    #[test]
    fn preparing_an_already_migrated_database_changes_nothing() {
        let connection = v1_database();
        insert_v1(&connection, "projects", &project("p-1", "One"));
        insert_v1(&connection, "chats", &chat_in("p-1", "c-1", "First"));

        // Idempotent: every launch runs this, and the second one must not rebuild
        // the tables again — a rebuild that ran on every start would rewrite the
        // whole workspace each time the app opened.
        prepare(&connection).unwrap();
        prepare(&connection).unwrap();

        let db = Db(Arc::new(Mutex::new(connection)));
        assert_eq!(load(&db).unwrap().unwrap().chats.len(), 1);
    }

    /* ---- document chunks ------------------------------------------------ */

    fn document(id: &str, project_id: &str, name: &str) -> Value {
        json!({ "id": id, "projectId": project_id, "name": name, "kind": "markdown",
                "tokens": 10, "updatedAt": "2026-07-01T00:00:00.000Z", "excerpt": "…" })
    }

    fn chunk(id: &str, project_id: &str, document_id: &str, index: i64) -> Value {
        json!({ "id": id, "projectId": project_id, "documentId": document_id,
                "index": index, "text": format!("body {index}"), "tokens": 4 })
    }

    /// A project with one document, plus the chunks that document is made of.
    fn seeded_with_document(db: &Db) {
        seed(
            db,
            &Patch {
                workspaces: vec![workspace("ws-1", "One")],
                projects: vec![project("p-1", "One")],
                documents: vec![document("d-1", "p-1", "Spec")],
                ..Default::default()
            },
        )
        .unwrap();

        put_chunks(
            db,
            "d-1",
            &[chunk("k-1", "p-1", "d-1", 0), chunk("k-2", "p-1", "d-1", 1)],
        )
        .unwrap();
    }

    #[test]
    fn document_text_is_absent_from_the_snapshot() {
        let db = Db::memory().unwrap();
        seeded_with_document(&db);

        // The whole reason for the second table: the launch read carries the
        // document's metadata and none of its text.
        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.documents.len(), 1);
        assert!(!snapshot.documents[0].get().contains("body 0"));
    }

    #[test]
    fn chunks_come_back_in_reading_order() {
        let db = Db::memory().unwrap();
        seeded_with_document(&db);
        // Inserted out of order, to prove the ORDER BY is doing the work rather
        // than rowid happening to agree with it.
        put_chunks(
            &db,
            "d-1",
            &[chunk("k-2", "p-1", "d-1", 1), chunk("k-1", "p-1", "d-1", 0)],
        )
        .unwrap();

        let chunks = load_chunks(&db, "p-1").unwrap();
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].get().contains("body 0"));
        assert!(chunks[1].get().contains("body 1"));
    }

    #[test]
    fn rewriting_a_document_does_not_leave_its_old_text_behind() {
        let db = Db::memory().unwrap();
        seeded_with_document(&db);

        // A shorter second version. An upsert would keep chunk two as text the
        // document no longer contains — still retrievable, still quotable.
        put_chunks(&db, "d-1", &[chunk("k-1", "p-1", "d-1", 0)]).unwrap();

        assert_eq!(load_chunks(&db, "p-1").unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_document_takes_its_text_with_it() {
        let db = Db::memory().unwrap();
        seeded_with_document(&db);

        apply(
            &db,
            &Patch {
                deleted_documents: vec!["d-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        assert!(load(&db).unwrap().unwrap().documents.is_empty());
        // Without the cascade this is where the megabytes would stay.
        assert!(load_chunks(&db, "p-1").unwrap().is_empty());
    }

    #[test]
    fn deleting_a_project_reaches_its_documents_text() {
        let db = Db::memory().unwrap();
        seeded_with_document(&db);

        apply(
            &db,
            &Patch {
                deleted_projects: vec!["p-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        // Two cascades deep: project -> document -> chunks.
        assert!(load_chunks(&db, "p-1").unwrap().is_empty());
    }

    #[test]
    fn chunks_of_one_project_do_not_leak_into_another() {
        let db = Db::memory().unwrap();
        seed(
            &db,
            &Patch {
                workspaces: vec![workspace("ws-1", "One")],
                projects: vec![project("p-1", "One"), project("p-2", "Two")],
                documents: vec![
                    document("d-1", "p-1", "Spec"),
                    document("d-2", "p-2", "Other"),
                ],
                ..Default::default()
            },
        )
        .unwrap();
        put_chunks(&db, "d-1", &[chunk("k-1", "p-1", "d-1", 0)]).unwrap();
        put_chunks(&db, "d-2", &[chunk("k-2", "p-2", "d-2", 0)]).unwrap();

        let chunks = load_chunks(&db, "p-1").unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].get().contains("k-1"));
    }

    /* ---- vectors -------------------------------------------------------- */

    fn vector(id: &str, project_id: &str, owner_id: &str, model: &str) -> StoredVector {
        StoredVector {
            id: id.into(),
            project_id: project_id.into(),
            kind: "passage".into(),
            owner_id: owner_id.into(),
            model: model.into(),
            fingerprint: format!("fp-{id}"),
            vector: "AAAAAA==".into(),
        }
    }

    fn seeded_with_projects(db: &Db) {
        seed(
            db,
            &Patch {
                workspaces: vec![workspace("ws-1", "One")],
                projects: vec![project("p-1", "One"), project("p-2", "Two")],
                ..Default::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn vectors_are_absent_from_the_snapshot() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);
        put_vectors(&db, &[vector("v-1", "p-1", "m-1", "model-a")]).unwrap();

        // Same bargain the chunks strike: the launch read carries the workspace
        // and none of the megabytes hanging off it.
        let snapshot = load(&db).unwrap().unwrap();
        assert_eq!(snapshot.projects.len(), 2);
        assert!(!snapshot.projects[0].get().contains("v-1"));
    }

    #[test]
    fn vectors_written_by_another_model_are_not_read_back() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);
        put_vectors(
            &db,
            &[
                vector("v-1", "p-1", "m-1", "model-a"),
                vector("v-2", "p-1", "m-2", "model-b"),
            ],
        )
        .unwrap();

        // Two models share a vector space only by coincidence. Mixing them does
        // not fail — it ranks by nonsense, which is why the filter is in the
        // query rather than left to whoever calls it.
        let found = load_vectors(&db, "p-1", "model-a").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "v-1");
    }

    #[test]
    fn re_embedding_a_passage_replaces_its_vector() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);
        put_vectors(&db, &[vector("v-1", "p-1", "m-1", "model-a")]).unwrap();

        let mut edited = vector("v-1", "p-1", "m-1", "model-a");
        edited.fingerprint = "fp-edited".into();
        edited.vector = "BBBBBB==".into();
        put_vectors(&db, &[edited]).unwrap();

        let found = load_vectors(&db, "p-1", "model-a").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].fingerprint, "fp-edited");
    }

    #[test]
    fn writing_one_projects_vectors_does_not_clear_anothers() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);
        put_vectors(&db, &[vector("v-1", "p-1", "m-1", "model-a")]).unwrap();
        put_vectors(&db, &[vector("v-2", "p-2", "m-2", "model-a")]).unwrap();

        // Vectors arrive incrementally — one new message is one row — so a
        // delete-then-insert like `put_chunks` does would drop the whole index
        // on every tick of the reindex loop.
        assert_eq!(load_vectors(&db, "p-1", "model-a").unwrap().len(), 1);
        assert_eq!(load_vectors(&db, "p-2", "model-a").unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_project_takes_its_vectors_with_it() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);
        put_vectors(&db, &[vector("v-1", "p-1", "m-1", "model-a")]).unwrap();

        apply(
            &db,
            &Patch {
                deleted_projects: vec!["p-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        assert!(load_vectors(&db, "p-1", "model-a").unwrap().is_empty());
    }

    #[test]
    fn a_vector_for_a_project_that_does_not_exist_is_refused() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);

        // The reindex that produced this was scanning a workspace the user has
        // since changed. Refusing is what keeps the index from outliving it.
        let result = put_vectors(&db, &[vector("v-1", "p-gone", "m-1", "model-a")]);
        assert!(result.unwrap_err().contains("FOREIGN KEY"));
    }

    #[test]
    fn dropped_vectors_stop_being_retrievable() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);
        put_vectors(
            &db,
            &[
                vector("v-1", "p-1", "m-1", "model-a"),
                vector("v-2", "p-1", "m-1", "model-a"),
            ],
        )
        .unwrap();

        // A message edited into fewer paragraphs. No cascade reaches this — the
        // message row is still there — and left behind it is quotable text the
        // conversation no longer contains.
        drop_vectors(&db, &["v-2".into()]).unwrap();

        let found = load_vectors(&db, "p-1", "model-a").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "v-1");
    }

    #[test]
    fn writing_and_dropping_nothing_are_both_no_ops() {
        let db = Db::memory().unwrap();
        seeded_with_projects(&db);
        // The reindex loop reaches both of these on every idle tick.
        put_vectors(&db, &[]).unwrap();
        drop_vectors(&db, &[]).unwrap();
        assert!(load_vectors(&db, "p-1", "model-a").unwrap().is_empty());
    }

    #[test]
    fn a_v1_database_gains_the_vectors_table() {
        let connection = v1_database();
        insert_v1(&connection, "projects", &project("p-1", "One"));

        // The migration rebuilds `projects`, which `vectors` points at. Creating
        // the table before that rebuild and having it survive is the thing worth
        // asserting — a dangling foreign key here would fail every write.
        prepare(&connection).unwrap();
        let db = Db(Arc::new(Mutex::new(connection)));

        put_vectors(&db, &[vector("v-1", "p-1", "m-1", "model-a")]).unwrap();
        assert_eq!(load_vectors(&db, "p-1", "model-a").unwrap().len(), 1);

        apply(
            &db,
            &Patch {
                deleted_projects: vec!["p-1".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(load_vectors(&db, "p-1", "model-a").unwrap().is_empty());
    }

    /* -- attachment blobs ------------------------------------------------- */

    fn attachment(id: &str, message_id: &str, chat_id: &str) -> StoredAttachment {
        StoredAttachment {
            id: id.into(),
            message_id: message_id.into(),
            chat_id: chat_id.into(),
            data: format!("data:image/png;base64,{id}"),
        }
    }

    fn seeded_with_transcript(db: &Db) {
        seed(
            db,
            &patch(
                vec![chat("c-1", "One"), chat("c-2", "Two")],
                vec![
                    message("m-1", "c-1", "look at this"),
                    message("m-2", "c-2", "and this"),
                ],
            ),
        )
        .unwrap();
    }

    #[test]
    fn attachment_bytes_are_absent_from_the_snapshot() {
        let db = Db::memory().unwrap();
        seeded_with_transcript(&db);
        put_attachments(&db, &[attachment("a-1", "m-1", "c-1")]).unwrap();

        // The whole reason the table exists: a launch reads the transcript
        // without reading a byte of any picture in it.
        let snapshot = load(&db).unwrap().expect("seeded");
        assert!(!snapshot.messages.iter().any(|m| m.get().contains("base64")));
    }

    #[test]
    fn attachments_load_for_one_chat_only() {
        let db = Db::memory().unwrap();
        seeded_with_transcript(&db);
        put_attachments(
            &db,
            &[
                attachment("a-1", "m-1", "c-1"),
                attachment("a-2", "m-2", "c-2"),
            ],
        )
        .unwrap();

        let found = load_attachments(&db, "c-1").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "a-1");
        assert_eq!(found[0].data, "data:image/png;base64,a-1");
    }

    #[test]
    fn re_sending_the_same_attachment_does_not_duplicate_it() {
        let db = Db::memory().unwrap();
        seeded_with_transcript(&db);
        put_attachments(&db, &[attachment("a-1", "m-1", "c-1")]).unwrap();
        put_attachments(&db, &[attachment("a-1", "m-1", "c-1")]).unwrap();

        assert_eq!(load_attachments(&db, "c-1").unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_chat_takes_its_attachments_with_it() {
        let db = Db::memory().unwrap();
        seeded_with_transcript(&db);
        put_attachments(&db, &[attachment("a-1", "m-1", "c-1")]).unwrap();

        apply(
            &db,
            &Patch {
                deleted_chats: vec!["c-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        // Through `messages`, which the chat delete cascades to first. Without
        // it, deleting a conversation would free the rows and keep the bytes.
        assert!(load_attachments(&db, "c-1").unwrap().is_empty());
    }

    #[test]
    fn deleting_a_project_reaches_its_attachments() {
        let db = Db::memory().unwrap();
        seeded_with_transcript(&db);
        put_attachments(&db, &[attachment("a-1", "m-1", "c-1")]).unwrap();

        apply(
            &db,
            &Patch {
                deleted_projects: vec!["p-1".into()],
                ..Default::default()
            },
        )
        .unwrap();

        assert!(load_attachments(&db, "c-1").unwrap().is_empty());
    }

    #[test]
    fn an_attachment_for_a_message_that_does_not_exist_is_refused() {
        let db = Db::memory().unwrap();
        seeded_with_transcript(&db);

        // The ordering rule the store obeys, enforced here: the message row has
        // to be committed before the bytes that hang off it.
        assert!(put_attachments(&db, &[attachment("a-1", "m-missing", "c-1")]).is_err());
    }

    #[test]
    fn writing_no_attachments_is_a_no_op() {
        let db = Db::memory().unwrap();
        seeded_with_transcript(&db);
        put_attachments(&db, &[]).unwrap();
        assert!(load_attachments(&db, "c-1").unwrap().is_empty());
    }

    #[test]
    fn a_v1_database_gains_the_attachments_table() {
        let connection = v1_database();
        insert_v1(&connection, "projects", &project("p-1", "One"));
        insert_v1(&connection, "chats", &chat("c-1", "One"));
        // v1 already carried `chat_id` as a column, so this one row cannot go
        // through `insert_v1`.
        connection
            .execute(
                "INSERT INTO messages (id, chat_id, data) VALUES ('m-1', 'c-1', ?1)",
                params![message("m-1", "c-1", "hi").to_string()],
            )
            .unwrap();

        // The migration rebuilds `chats`, which `messages` points at and which
        // `attachment_blobs` reaches through. Creating the blob table before
        // that rebuild and having it survive is what is worth asserting.
        prepare(&connection).unwrap();
        let db = Db(Arc::new(Mutex::new(connection)));

        put_attachments(&db, &[attachment("a-1", "m-1", "c-1")]).unwrap();
        assert_eq!(load_attachments(&db, "c-1").unwrap().len(), 1);
    }
}
