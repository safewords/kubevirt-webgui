//! `AUTH_REQUIRED` (the default): nothing is served to someone who has not
//! signed in. (`AUTH_REQUIRED=false` is open access instead: no gate, and every
//! visitor is the server's identity — see `Settings::require_auth`.)
//!
//! Without it, signing in is still the only way to *do* anything (every API
//! request is made with the visitor's own credential), but the application
//! shell, its assets, `/plugins/` and the gateway's `hello` frame — which names
//! the cluster, the extensions and the plugin URLs — are open to anyone who can
//! reach the port. With it, all of that sits behind a session cookie:
//!
//! - a request without a valid cookie gets a small sign-in page (or a 401 for
//!   anything that is not a page), and every socket is refused;
//! - the page posts a token to `/auth/login`, which checks it exactly as the
//!   gateway's `auth.login` does and sets the cookie;
//! - the cookie's value **is** the gateway ticket — the credential sealed with
//!   `APP_KEY` — so there is still no server-side session store. The browser
//!   app reads it once from `/auth/ticket` to resume the gateway session, and
//!   hands each renewed ticket back to `/auth/session` so the cookie lives as
//!   long as the session does.
//!
//! `/healthz` stays open for the kubelet's probes.

use std::sync::Arc;

use rainier_framework::http::{Cookie, Request, SameSite};
use rainier_framework::prelude::{Req, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;

use crate::auth::Session;
use crate::cluster::Credential;
use crate::state::State;

/// The session cookie.
pub const COOKIE: &str = "kve_session";

/// Whether the gate is up at all.
pub fn enabled(state: &State) -> bool {
    state.settings.require_auth
}

/// The session behind a request's cookie, if it is valid and unexpired.
pub fn session(state: &State, request: &Request) -> Option<Arc<Session>> {
    let ticket = request.cookie(COOKIE)?;
    state.auth.resume(ticket).ok()
}

/// May this request through? Always, when the gate is down.
pub fn admits(state: &State, request: &Request) -> bool {
    !enabled(state) || session(state, request).is_some()
}

/// Same-origin check for the gate's own `POST`s, on top of `SameSite=Strict`:
/// a foreign page must not be able to sign a visitor in or out.
fn same_origin(state: &State, request: &Request) -> bool {
    if request.header("origin").is_none() && request.header("sec-fetch-site").is_some_and(|s| s != "same-origin") {
        return false;
    }
    crate::gateway::origin_allowed(state, request)
}

/// `Secure` when the browser reached us over HTTPS (directly, or through an
/// ingress that says so). Over plain HTTP a `Secure` cookie is never sent back.
fn over_https(request: &Request) -> bool {
    request.header("x-forwarded-proto").is_some_and(|p| p.eq_ignore_ascii_case("https"))
}

fn session_cookie(ticket: &str, max_age: i64, secure: bool) -> Cookie {
    Cookie::new(COOKIE, ticket).path("/").http_only(true).same_site(SameSite::Strict).secure(secure).max_age(max_age)
}

fn set_cookie(state: &State, request: &Request, ticket: &str) -> Cookie {
    session_cookie(ticket, state.settings.session_ttl.as_secs() as i64, over_https(request))
}

fn clear_cookie(request: &Request) -> Cookie {
    session_cookie("", 0, over_https(request))
}

/// Where to go after signing in: a path on this site, never another one.
fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(path)
            if path.starts_with('/')
                && !path.starts_with("//")
                && !path.contains('\\')
                && !path.chars().any(|c| c.is_control()) =>
        {
            path.to_string()
        }
        _ => String::from("/"),
    }
}

/// A browser navigating to a page, as opposed to fetching an asset or a module.
fn wants_page(request: &Request) -> bool {
    let path = request.path();
    let last = path.rsplit('/').next().unwrap_or_default();
    request.method() == rainier_framework::http::Method::GET
        && !path.starts_with("/assets/")
        && !path.starts_with("/plugins/")
        && !last.contains('.')
}

fn escape(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&#39;".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// The sign-in page: one form, no script, nothing loaded from elsewhere.
fn login_page(product: &str, next: &str, error: Option<&str>, status: StatusCode) -> Response {
    let product = escape(product);
    let next = escape(next);
    let error = error.map(|e| format!(r#"<p class="error" role="alert">{}</p>"#, escape(e))).unwrap_or_default();
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · {product}</title>
<style>
  :root {{ color-scheme: light dark; --bg:#f4f5f7; --panel:#fff; --fg:#1d2330; --muted:#5b6475; --line:#d5d9e0; --accent:#2f6fde; --err:#b42318; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg:#14171c; --panel:#1d2128; --fg:#e6e8ec; --muted:#9aa3b2; --line:#323844; --accent:#5b8ff0; --err:#f97066; }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; padding:16px; }}
  form {{ width:100%; max-width:420px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:24px; }}
  h1 {{ margin:0 0 4px; font-size:18px; }}
  p {{ margin:0 0 16px; color:var(--muted); }}
  label {{ display:block; font-weight:600; margin-bottom:6px; }}
  textarea {{ width:100%; min-height:110px; font:12px/1.4 ui-monospace, monospace; padding:8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; resize:vertical; }}
  button {{ margin-top:16px; width:100%; padding:9px; border:0; border-radius:6px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }}
  .error {{ color:var(--err); margin:0 0 12px; }}
</style>
</head>
<body>
<form method="post" action="/auth/login">
  <h1>{product}</h1>
  <p>Sign in with a Kubernetes token (a ServiceAccount token or an OIDC ID token).</p>
  {error}
  <label for="token">Token</label>
  <textarea id="token" name="token" required autocomplete="off" spellcheck="false" autofocus></textarea>
  <input type="hidden" name="next" value="{next}">
  <button type="submit">Sign in</button>
</form>
</body>
</html>
"#
    );
    Response::html(html)
        .with_status(status)
        .with_header("cache-control", "no-store")
        .with_header("x-content-type-options", "nosniff")
        .with_header("referrer-policy", "same-origin")
        .with_header("x-frame-options", "DENY")
        .with_header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
}

fn unauthorized() -> Response {
    Response::new(StatusCode::UNAUTHORIZED)
        .with_content_type("text/plain; charset=utf-8")
        .with_header("cache-control", "no-store")
        .with_body("Sign in first.")
}

/// Everything the gate does not handle itself: the browser application.
pub async fn serve(state: Arc<State>, request: Req) -> Response {
    if admits(&state, &request) {
        return crate::spa::serve(request).await;
    }
    if wants_page(&request) {
        let next = safe_next(Some(request.path()));
        return login_page(&state.settings.product_name, &next, None, StatusCode::OK);
    }
    unauthorized()
}

#[derive(Deserialize)]
struct LoginForm {
    #[serde(default)]
    token: String,
    #[serde(default)]
    next: Option<String>,
}

/// `POST /auth/login` — the sign-in page's form.
pub async fn login(state: Arc<State>, request: Req) -> Response {
    let product = state.settings.product_name.clone();
    if !same_origin(&state, &request) {
        return Response::new(StatusCode::FORBIDDEN).with_body("Cross-site sign-in refused.");
    }
    let form: LoginForm = match request.form() {
        Ok(form) => form,
        Err(_) => return login_page(&product, "/", Some("The form did not arrive intact."), StatusCode::BAD_REQUEST),
    };
    let next = safe_next(form.next.as_deref());
    match state.auth.login(Credential::Token { token: form.token.trim().to_string() }).await {
        Ok((ticket, session)) => {
            tracing::info!(user = session.user.username, "signed in at the gate");
            Response::new(StatusCode::SEE_OTHER)
                .with_header("location", &next)
                .with_header("cache-control", "no-store")
                .with_cookie(&set_cookie(&state, &request, &ticket))
        }
        Err(e) => {
            let status =
                StatusCode::from_u16(if e.status == 0 { 502 } else { e.status }).unwrap_or(StatusCode::UNAUTHORIZED);
            login_page(&product, &next, Some(&e.message), status)
        }
    }
}

#[derive(Deserialize)]
struct TicketBody {
    ticket: String,
}

/// `POST /auth/session` — the browser app hands over a ticket it just got
/// (sign-in or renewal), so the cookie lasts as long as the session.
pub async fn refresh(state: Arc<State>, request: Req) -> Response {
    if !same_origin(&state, &request) {
        return Response::new(StatusCode::FORBIDDEN);
    }
    let Ok(body) = request.json::<TicketBody>() else {
        return Response::new(StatusCode::BAD_REQUEST);
    };
    match state.auth.resume(&body.ticket) {
        Ok(_) => Response::new(StatusCode::NO_CONTENT)
            .with_header("cache-control", "no-store")
            .with_cookie(&set_cookie(&state, &request, &body.ticket)),
        Err(_) => unauthorized(),
    }
}

/// `GET /auth/ticket` — the ticket behind the cookie, for the browser app to
/// resume its gateway session without asking for the token a second time.
/// Same-origin only: the response is no use to another site anyway (no CORS),
/// but it should not even be produced for one.
pub async fn ticket(state: Arc<State>, request: Req) -> Response {
    if !same_origin(&state, &request) {
        return Response::new(StatusCode::FORBIDDEN);
    }
    match (request.cookie(COOKIE), session(&state, &request)) {
        (Some(ticket), Some(session)) => Response::json(&json!({ "ticket": ticket, "expires": session.expires }))
            .with_header("cache-control", "no-store"),
        _ => unauthorized(),
    }
}

/// `POST /auth/logout` — forget the cookie. A form post lands back on the
/// sign-in page; the browser app's `fetch` just gets a 204.
pub async fn logout(state: Arc<State>, request: Req) -> Response {
    if !same_origin(&state, &request) {
        return Response::new(StatusCode::FORBIDDEN);
    }
    let response = if request.header("accept").is_some_and(|a| a.contains("text/html")) {
        Response::new(StatusCode::SEE_OTHER).with_header("location", "/")
    } else {
        Response::new(StatusCode::NO_CONTENT)
    };
    response.with_header("cache-control", "no-store").with_cookie(&clear_cookie(&request))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_stays_on_this_site() {
        assert_eq!(safe_next(Some("/n/VirtualMachine/default/vm1")), "/n/VirtualMachine/default/vm1");
        assert_eq!(safe_next(Some("/")), "/");
        assert_eq!(safe_next(Some("//evil.example/")), "/");
        assert_eq!(safe_next(Some("https://evil.example/")), "/");
        assert_eq!(safe_next(Some("/\\evil.example")), "/");
        assert_eq!(safe_next(Some("/a\r\nSet-Cookie: x=y")), "/");
        assert_eq!(safe_next(Some("relative")), "/");
        assert_eq!(safe_next(None), "/");
    }

    #[test]
    fn the_page_escapes_what_it_echoes() {
        assert_eq!(escape(r#"<script>"x"&'y'</script>"#), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
    }

    #[test]
    fn the_cookie_is_a_session_cookie() {
        let header = session_cookie("sealed", 3600, true).to_set_cookie();
        for part in ["kve_session=sealed", "Path=/", "HttpOnly", "SameSite=Strict", "Secure", "Max-Age=3600"] {
            assert!(header.contains(part), "{header} lacks {part}");
        }
        let plain = session_cookie("sealed", 3600, false).to_set_cookie();
        assert!(!plain.contains("Secure"), "{plain}");
        assert!(session_cookie("", 0, false).to_set_cookie().contains("Max-Age=0"));
    }
}
