use serde::{Deserialize, Serialize};
use somework_core::{Error, contracts::Action};

use super::{TaskRow, TaskView};
use crate::{
    db::{DbResultExt, scol},
    domain::{Ctx, Domain},
    policy::AuthzRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskFilter {
    pub state: Option<String>,
    pub capability_id: Option<String>,
    pub requester_id: Option<String>,
    pub assignee_id: Option<String>,
    pub conversation_id: Option<String>,
    pub parent_task_id: Option<String>,
    /// Operators only: list tasks of every requester instead of the caller's own.
    pub all: Option<bool>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    pub tasks: Vec<TaskView>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTreeNode {
    pub task: TaskView,
    pub children: Vec<TaskTreeNode>,
}

impl Domain {
    pub async fn list_tasks(&self, ctx: &Ctx, filter: TaskFilter) -> Result<TaskList, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::TaskRead)).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let operator = ctx.actor.permissions.allows_action("task.read.any");
        let all = filter.all.unwrap_or(false) && operator;
        let limit = filter.limit.unwrap_or(50).clamp(1, 200);
        // cursor: "<created_at>|<task_id>" of the last row of the previous page (newest first)
        let (cursor_ts, cursor_id) = match filter.cursor.as_deref().and_then(|c| c.split_once('|')) {
            Some((t, i)) => (Some(t.to_string()), Some(i.to_string())),
            None => (None, None),
        };
        let rows = sqlx::query(
            "SELECT * FROM tasks t WHERE (? = 1 OR t.requester_principal_id = ? OR t.assignee_principal_id = ? OR t.target_agent_id = ?
                OR (t.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE principal_id = ?) AND ? = 'human'))
               AND (? IS NULL OR t.state = ?) AND (? IS NULL OR t.capability_id = ?)
               AND (? IS NULL OR json_extract(t.requester, '$.id') = ?) AND (? IS NULL OR t.assignee_agent_id = ?)
               AND (? IS NULL OR t.conversation_id = ?) AND (? IS NULL OR t.parent_task_id = ?)
               AND (? IS NULL OR (t.created_at < ?) OR (t.created_at = ? AND t.task_id < ?))
             ORDER BY t.created_at DESC, t.task_id DESC LIMIT ?",
        )
        .bind(all as i64)
        .bind(&ctx.actor.principal_id)
        .bind(&ctx.actor.principal_id)
        .bind(&ctx.actor.id)
        .bind(&ctx.actor.principal_id)
        .bind(ctx.actor.kind_str())
        .bind(&filter.state)
        .bind(&filter.state)
        .bind(&filter.capability_id)
        .bind(&filter.capability_id)
        .bind(&filter.requester_id)
        .bind(&filter.requester_id)
        .bind(&filter.assignee_id)
        .bind(&filter.assignee_id)
        .bind(&filter.conversation_id)
        .bind(&filter.conversation_id)
        .bind(&filter.parent_task_id)
        .bind(&filter.parent_task_id)
        .bind(&cursor_ts)
        .bind(&cursor_ts)
        .bind(&cursor_ts)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await
        .db()?;
        let mut tasks = Vec::new();
        let mut next_cursor = None;
        for (i, r) in rows.iter().enumerate() {
            if i as i64 == limit {
                let last = &tasks_last(&tasks);
                next_cursor = last.clone();
                break;
            }
            let row = TaskRow::from_row(r)?;
            let view = self.task_view(&mut conn, &row).await?;
            tasks.push(view);
        }
        let _ = scol;
        Ok(TaskList { next_cursor, tasks })
    }

    /// Task DAG rooted at `task_id` (delegation lineage), for the introspection UI.
    pub async fn task_tree(&self, ctx: &Ctx, task_id: &str) -> Result<TaskTreeNode, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::TaskRead).resource(format!("task://{task_id}"))).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        // climb to the root the caller is allowed to see, then walk down
        let mut current = self.require_task_participant(&mut conn, ctx, task_id).await?;
        while let Some(parent) = current.parent_task_id.clone() {
            match self.require_task_participant(&mut conn, ctx, &parent).await {
                Ok(p) => current = p,
                Err(_) => break,
            }
        }
        self.build_tree(&mut conn, ctx, current, 0).await
    }

    fn build_tree<'a>(
        &'a self,
        conn: &'a mut sqlx::SqliteConnection,
        ctx: &'a Ctx,
        row: TaskRow,
        depth: usize,
    ) -> futures::future::BoxFuture<'a, Result<TaskTreeNode, Error>> {
        Box::pin(async move {
            let view = self.task_view(conn, &row).await?;
            let mut children = Vec::new();
            if depth < 16 {
                let child_rows =
                    sqlx::query("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at").bind(&row.task_id).fetch_all(&mut *conn).await.db()?;
                for r in child_rows {
                    let child = TaskRow::from_row(&r)?;
                    if self.is_task_participant(conn, ctx, &child).await? {
                        children.push(self.build_tree(conn, ctx, child, depth + 1).await?);
                    }
                }
            }
            Ok(TaskTreeNode { task: view, children })
        })
    }
}

fn tasks_last(tasks: &[TaskView]) -> Option<String> {
    tasks.last().map(|t| format!("{}|{}", t.task.created_at, t.task.task_id))
}
