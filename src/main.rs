//! The console entry point.
//!
//! ```sh
//! kubevirt-webgui                     # same as `serve`
//! kubevirt-webgui serve --host=0.0.0.0 --port=8006
//! kubevirt-webgui route:list
//! kubevirt-webgui netagent              # the node agent (a DaemonSet), not the GUI
//! ```

#[tokio::main]
async fn main() {
    // The node agent shares the binary but none of the GUI: no routes, no
    // sessions, no APP_KEY.
    if std::env::args().nth(1).as_deref() == Some("netagent") {
        let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into());
        let filter = tracing_subscriber::EnvFilter::try_new(filter).unwrap_or_else(|_| "info".into());
        let _ = tracing_subscriber::fmt().with_env_filter(filter).json().flatten_event(true).try_init();
        if let Err(e) = kubevirt_webgui::netagent::run().await {
            eprintln!("netagent could not start: {e:#}");
            std::process::exit(1);
        }
        return;
    }

    let (app, _state) = match kubevirt_webgui::bootstrap::boot().await {
        Ok(booted) => booted,
        Err(e) => {
            eprintln!("kubevirt-webgui could not start: {e:#}");
            std::process::exit(1);
        }
    };

    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() {
        argv.push("serve".into());
    }

    let code = rainier_framework::console(env!("CARGO_PKG_NAME")).run_argv(&app, argv).await;
    app.terminate();
    std::process::exit(code);
}
