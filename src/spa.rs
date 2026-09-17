//! The browser application, embedded in the binary.
//!
//! `web/dist` is compiled in for release builds and read from disk in debug
//! builds, so `npm run build` is picked up without recompiling Rust.

use rainier_framework::prelude::{Req, Response, StatusCode};
use rust_embed::RustEmbed;

/// Where `/plugins/` is served from, when configured.
static PLUGIN_DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();

pub fn set_plugin_dir(dir: Option<std::path::PathBuf>) {
    let _ = PLUGIN_DIR.set(dir);
}

/// The plugin modules in the plugin directory, as URLs the browser imports.
pub fn discovered_plugins() -> Vec<String> {
    let Some(Some(dir)) = PLUGIN_DIR.get() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut urls: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.ends_with(".js") || name.ends_with(".mjs"))
        .filter(|name| safe_plugin_path(name))
        .map(|name| format!("/plugins/{name}"))
        .collect();
    urls.sort();
    urls
}

fn safe_plugin_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && path.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/'))
}

async fn plugin_file(path: &str) -> Option<Response> {
    let dir = PLUGIN_DIR.get()?.as_ref()?;
    if !safe_plugin_path(path) {
        return Some(Response::new(StatusCode::NOT_FOUND));
    }
    let bytes = tokio::fs::read(dir.join(path)).await.ok()?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mime = if path.ends_with(".mjs") || path.ends_with(".js") { "text/javascript; charset=utf-8".to_string() } else { mime.to_string() };
    Some(secured(Response::ok(bytes).with_content_type(&mime).with_header("cache-control", "no-cache")))
}

#[derive(RustEmbed)]
#[folder = "web/dist/"]
#[allow_missing = true]
struct Assets;

#[cfg(test)]
mod tests {
    use super::safe_plugin_path;

    #[test]
    fn plugin_paths_cannot_escape_the_directory() {
        assert!(safe_plugin_path("backups.js"));
        assert!(safe_plugin_path("vendor/chart.js"));
        assert!(!safe_plugin_path("../secrets.js"));
        assert!(!safe_plugin_path("a/../../b.js"));
        assert!(!safe_plugin_path("/etc/passwd"));
        assert!(!safe_plugin_path("x%2e%2e/y.js"));
    }
}

fn secured(response: Response) -> Response {
    response
        .with_header("x-content-type-options", "nosniff")
        .with_header("referrer-policy", "same-origin")
        .with_header("x-frame-options", "SAMEORIGIN")
        .with_header(
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; \
             worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'none'",
        )
}

/// Serve an asset, or `index.html` for any route the browser app owns.
pub async fn serve(request: Req) -> Response {
    let path = request.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(plugin) = path.strip_prefix("plugins/") {
        return plugin_file(plugin).await.unwrap_or_else(|| Response::new(StatusCode::NOT_FOUND));
    }

    if let Some(file) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        // Vite fingerprints everything under `assets/`, so those never change.
        let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
        return secured(
            Response::ok(file.data.into_owned())
                .with_content_type(mime.as_ref())
                .with_header("cache-control", cache),
        );
    }

    // A missing file is a 404; a missing *route* is the app's to render.
    let last = path.rsplit('/').next().unwrap_or_default();
    if path.starts_with("assets/") || last.contains('.') {
        return Response::new(StatusCode::NOT_FOUND);
    }

    match Assets::get("index.html") {
        Some(index) => secured(
            Response::ok(index.data.into_owned())
                .with_content_type("text/html; charset=utf-8")
                .with_header("cache-control", "no-cache"),
        ),
        None => Response::new(StatusCode::SERVICE_UNAVAILABLE)
            .with_content_type("text/plain; charset=utf-8")
            .with_body("The web interface has not been built. Run `npm run build` in `web/`."),
    }
}
