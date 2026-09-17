//! The console entry point.
//!
//! ```sh
//! kubevirt-webgui                     # same as `serve`
//! kubevirt-webgui serve --host=0.0.0.0 --port=8006
//! kubevirt-webgui route:list
//! ```

#[tokio::main]
async fn main() {
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
