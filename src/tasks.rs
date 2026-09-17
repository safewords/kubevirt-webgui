//! Tasks — Proxmox's task log, for operations that outlive a request.
//!
//! Starting a VM returns as soon as the API server accepts the request; the
//! VM being *up* happens later. A task records that whole arc — what was
//! asked, by whom, each step as it happened, and how it ended — and streams
//! it to every browser the user has open.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::broadcast;
use tokio::task::AbortHandle;

use crate::rpc::RpcError;

const KEEP: usize = 1000;
const LOG_LINES: usize = 2000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Ok,
    Warning,
    Error,
    Stopped,
}

/// What a task acts on.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskTarget {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    /// `UPID:<user>:<started>:<seq>:<kind>:<target>` — unique and readable.
    pub id: String,
    pub kind: String,
    pub description: String,
    pub target: TaskTarget,
    pub user: String,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub ts: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    #[serde(skip)]
    pub user: String,
    pub task: TaskInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<LogLine>,
}

struct Entry {
    info: Mutex<TaskInfo>,
    log: Mutex<VecDeque<LogLine>>,
    abort: Mutex<Option<AbortHandle>>,
}

/// Every task this process knows about.
pub struct TaskManager {
    tasks: Mutex<VecDeque<Arc<Entry>>>,
    events: broadcast::Sender<TaskEvent>,
    seq: std::sync::atomic::AtomicU64,
}

impl Default for TaskManager {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(VecDeque::new()),
            events: broadcast::channel(1024).0,
            seq: Default::default(),
        }
    }
}

/// The running task's side: log, then finish.
#[derive(Clone)]
pub struct TaskHandle {
    entry: Arc<Entry>,
    events: broadcast::Sender<TaskEvent>,
}

impl TaskHandle {
    pub fn id(&self) -> String {
        self.entry.info.lock().unwrap().id.clone()
    }

    /// Append a line to the task log.
    pub fn log(&self, text: impl Into<String>) {
        let line = LogLine { ts: chrono::Utc::now().timestamp_millis(), text: text.into() };
        {
            let mut log = self.entry.log.lock().unwrap();
            if log.len() >= LOG_LINES {
                log.pop_front();
            }
            log.push_back(line.clone());
        }
        let info = self.entry.info.lock().unwrap().clone();
        let _ = self.events.send(TaskEvent { user: info.user.clone(), task: info, line: Some(line) });
    }

    fn finish(&self, status: TaskStatus, message: Option<String>) {
        let info = {
            let mut info = self.entry.info.lock().unwrap();
            if info.status != TaskStatus::Running {
                return;
            }
            info.status = status;
            info.message = message;
            info.ended_at = Some(chrono::Utc::now().timestamp_millis());
            info.clone()
        };
        let _ = self.events.send(TaskEvent { user: info.user.clone(), task: info, line: None });
    }
}

impl TaskManager {
    /// Changes to tasks, as they happen.
    pub fn subscribe(&self) -> broadcast::Receiver<TaskEvent> {
        self.events.subscribe()
    }

    /// Run `work` as a task and return its id at once.
    ///
    /// The work's `Ok(message)` ends the task `OK`; an `Err` ends it in error
    /// with the message logged — the task log is where a failure is explained.
    pub fn spawn<F, Fut>(&self, user: &str, kind: &str, target: TaskTarget, description: impl Into<String>, work: F) -> String
    where
        F: FnOnce(TaskHandle) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<String>, RpcError>> + Send + 'static,
    {
        let started = chrono::Utc::now().timestamp_millis();
        let seq = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let id = format!(
            "UPID:{}:{:X}:{:X}:{}:{}",
            user,
            started,
            seq,
            kind,
            match &target.namespace {
                Some(ns) => format!("{ns}/{}", target.name),
                None => target.name.clone(),
            }
        );

        let info = TaskInfo {
            id: id.clone(),
            kind: kind.to_string(),
            description: description.into(),
            target,
            user: user.to_string(),
            started_at: started,
            ended_at: None,
            status: TaskStatus::Running,
            message: None,
        };
        let entry = Arc::new(Entry {
            info: Mutex::new(info.clone()),
            log: Mutex::new(VecDeque::new()),
            abort: Mutex::new(None),
        });
        {
            let mut tasks = self.tasks.lock().unwrap();
            if tasks.len() >= KEEP {
                tasks.pop_front();
            }
            tasks.push_back(entry.clone());
        }
        let _ = self.events.send(TaskEvent { user: user.to_string(), task: info, line: None });

        let handle = TaskHandle { entry: entry.clone(), events: self.events.clone() };
        let runner = handle.clone();
        let join = tokio::spawn(async move {
            match work(runner.clone()).await {
                Ok(message) => {
                    if let Some(message) = &message {
                        runner.log(message.clone());
                    }
                    runner.log("TASK OK");
                    runner.finish(TaskStatus::Ok, message);
                }
                Err(e) => {
                    runner.log(format!("TASK ERROR: {}", e.message));
                    runner.finish(TaskStatus::Error, Some(e.message));
                }
            }
        });
        *entry.abort.lock().unwrap() = Some(join.abort_handle());
        id
    }

    /// The most recent tasks started by `user`, newest first.
    pub fn list(&self, user: &str, limit: usize) -> Vec<TaskInfo> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .rev()
            .map(|entry| entry.info.lock().unwrap().clone())
            .filter(|info| info.user == user)
            .take(limit)
            .collect()
    }

    fn find(&self, user: &str, id: &str) -> Option<Arc<Entry>> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .find(|entry| {
                let info = entry.info.lock().unwrap();
                info.id == id && info.user == user
            })
            .cloned()
    }

    /// A task and its log, if `user` started it.
    pub fn detail(&self, user: &str, id: &str) -> Option<(TaskInfo, Vec<LogLine>)> {
        let entry = self.find(user, id)?;
        let info = entry.info.lock().unwrap().clone();
        let log = entry.log.lock().unwrap().iter().cloned().collect();
        Some((info, log))
    }

    /// Stop a running task.
    pub fn stop(&self, user: &str, id: &str) -> bool {
        let Some(entry) = self.find(user, id) else { return false };
        if let Some(abort) = entry.abort.lock().unwrap().take() {
            abort.abort();
        }
        let handle = TaskHandle { entry, events: self.events.clone() };
        handle.log("TASK STOPPED by user request");
        handle.finish(TaskStatus::Stopped, Some("stopped".into()));
        true
    }
}
