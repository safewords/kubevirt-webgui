//! Application settings, read once from the environment (and `.env`).

use std::time::Duration;

use rainier_framework::config::Env;

/// Everything the application reads from its environment.
#[derive(Debug, Clone)]
pub struct Settings {
    /// The product name shown in the browser.
    pub product_name: String,
    /// The kubeconfig context whose cluster (URL + CA) the GUI talks to.
    /// Unset: in-cluster configuration, then the current kubeconfig context.
    pub kube_context: Option<String>,
    /// Overrides the API server URL taken from the kubeconfig.
    pub kube_api_server: Option<String>,
    /// Allow signing in as the server's own kubeconfig identity. Intended for
    /// a single-user desktop install; never enable it on a shared deployment.
    pub allow_server_identity: bool,
    /// How long a sign-in lasts before the browser must renew it.
    pub session_ttl: Duration,
    /// How long a console ticket may wait to be redeemed.
    pub console_ticket_ttl: Duration,
    /// Origins allowed to open sockets, in addition to the host serving the GUI.
    pub allowed_origins: Vec<String>,
    /// Extra browser plugin modules to load at start-up (ES module URLs).
    pub plugin_urls: Vec<String>,
    /// A directory served at `/plugins/`, for plugin modules that are not
    /// compiled in. Every `*.js` file directly inside it is loaded.
    pub plugin_dir: Option<std::path::PathBuf>,
    /// Backend extensions to leave switched off, by id.
    pub disabled_extensions: Vec<String>,
    /// The largest frame a client may send on the gateway socket.
    pub max_frame_bytes: usize,
}

fn list(env: &Env, key: &str) -> Vec<String> {
    env.string(key, "")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn optional(env: &Env, key: &str) -> Option<String> {
    let value = env.string(key, "");
    (!value.trim().is_empty()).then(|| value.trim().to_string())
}

impl Settings {
    /// Read the settings.
    pub fn from_env(env: &Env) -> Self {
        Self {
            product_name: env.string("GUI_PRODUCT_NAME", "kubevirt-webgui"),
            kube_context: optional(env, "KUBE_CONTEXT"),
            kube_api_server: optional(env, "KUBE_API_SERVER"),
            allow_server_identity: env.bool("AUTH_ALLOW_SERVER_IDENTITY", false),
            session_ttl: Duration::from_secs(env.int("AUTH_SESSION_TTL", 8 * 3600).max(300) as u64),
            console_ticket_ttl: Duration::from_secs(env.int("CONSOLE_TICKET_TTL", 60).max(5) as u64),
            allowed_origins: list(env, "GUI_ALLOWED_ORIGINS"),
            plugin_urls: list(env, "GUI_PLUGIN_URLS"),
            plugin_dir: optional(env, "GUI_PLUGIN_DIR").map(std::path::PathBuf::from),
            disabled_extensions: list(env, "GUI_DISABLED_EXTENSIONS"),
            max_frame_bytes: env.int("GUI_MAX_FRAME_BYTES", 16 * 1024 * 1024).max(64 * 1024) as usize,
        }
    }
}
