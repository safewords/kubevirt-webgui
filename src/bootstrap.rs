//! Assembling the application.

use std::sync::Arc;

use rainier_framework::crypt::Encryption;
use rainier_framework::prelude::*;
use rainier_framework::config::Env;

use crate::cluster::Cluster;
use crate::extensions;
use crate::gateway::Gateway;
use crate::gateway::console::ConsoleProxy;
use crate::gateway::upload::UploadProxy;
use crate::settings::Settings;
use crate::spa;
use crate::state::State;

pub async fn boot() -> anyhow::Result<(Arc<Application>, Arc<State>)> {
    let env = Env::load_or_default(".env");
    let settings = Settings::from_env(&env);

    spa::set_plugin_dir(settings.plugin_dir.clone());
    let cluster = Arc::new(Cluster::load(&settings).await?);
    let registry = extensions::registry(&settings.disabled_extensions);
    let state = State::new(settings, cluster, registry);

    let sockets = WebSocketRoutes::new()
        .add("/ws", Gateway::new(state.clone()))
        .add("/ws/console/{ticket}", ConsoleProxy::new(state.clone()))
        .add("/ws/upload/{ticket}", UploadProxy::new(state.clone()));

    let app = Rainier::new(".")
        .with_routes(|router| {
            router.get("/healthz", || async { "ok" }).name("health");
            router.fallback(spa::serve);
        })
        .with_websockets(sockets)
        .boot()
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;

    let crypt = app.resolve::<Encryption>().map_err(|e| anyhow::anyhow!("{}", e.message()))?;
    state.auth.set_encryption(crypt);

    Ok((app, state))
}
