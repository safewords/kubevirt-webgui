//! The application's shared state.

use std::sync::Arc;

use crate::auth::Auth;
use crate::cluster::Cluster;
use crate::gateway::console::ConsoleTickets;
use crate::metrics::MetricsStore;
use crate::rpc::Registry;
use crate::settings::Settings;
use crate::tasks::TaskManager;

pub struct State {
    pub settings: Settings,
    pub cluster: Arc<Cluster>,
    pub auth: Auth,
    pub tasks: TaskManager,
    pub registry: Registry,
    pub consoles: ConsoleTickets,
    pub metrics: MetricsStore,
}

impl State {
    pub fn new(settings: Settings, cluster: Arc<Cluster>, registry: Registry) -> Arc<Self> {
        Arc::new(Self {
            auth: Auth::new(settings.clone(), cluster.clone()),
            consoles: ConsoleTickets::new(settings.console_ticket_ttl),
            settings,
            cluster,
            tasks: TaskManager::default(),
            registry,
            metrics: MetricsStore::default(),
        })
    }
}
