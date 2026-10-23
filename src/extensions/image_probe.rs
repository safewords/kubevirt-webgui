//! How big a disk an image at a URL needs, before CDI downloads it.
//!
//! The download dialog used to start at 10 GiB whatever the URL: too small for
//! a Windows ISO, far too big for a cloud image. One ranged GET of the first
//! 64 KiB answers it for the common cases — the file's length from
//! `Content-Range` (or `Content-Length`), its format from its magic bytes,
//! and, for qcow2, the virtual size from the header, which is what the disk
//! must actually hold. Only those numbers go back to the browser, never the
//! bytes.

use std::sync::Arc;
use std::time::Duration;

use http::{Request, Uri, header};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use rustls_pki_types::ServerName;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 5;
const HEAD_BYTES: u64 = 64 * 1024;

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The file's length in bytes, when the server says.
    pub file_size: Option<u64>,
    /// What the disk holds once CDI has converted it: qcow2's virtual size,
    /// or the file itself for a raw image or ISO. `None` when it cannot be
    /// known without downloading — a compressed file, say.
    pub virtual_size: Option<u64>,
    /// `qcow2`, `iso`, `vmdk`, `vhdx`, `vhd`, `xz`, `gzip`, `zstd`, or `raw`.
    pub format: String,
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

fn tls() -> Result<Arc<rustls::ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// One GET of the first bytes of `uri`: status, headers, body.
async fn fetch_head(uri: &Uri) -> Result<(u16, http::HeaderMap, Bytes), String> {
    let host = uri.host().ok_or("the URL has no host")?.to_string();
    let https = match uri.scheme_str() {
        Some("https") => true,
        Some("http") => false,
        _ => return Err("only http and https URLs can be probed".into()),
    };
    let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
    let tcp =
        TcpStream::connect((host.as_str(), port)).await.map_err(|e| format!("could not connect to {host}: {e}"))?;
    let io: Box<dyn Io> = if https {
        let name = ServerName::try_from(host.clone()).map_err(|e| format!("invalid host {host}: {e}"))?;
        Box::new(
            tokio_rustls::TlsConnector::from(tls()?)
                .connect(name, tcp)
                .await
                .map_err(|e| format!("TLS with {host} failed: {e}"))?,
        )
    } else {
        Box::new(tcp)
    };
    let (mut sender, connection) = hyper::client::conn::http1::handshake::<_, Empty<Bytes>>(TokioIo::new(io))
        .await
        .map_err(|e| format!("HTTP with {host} failed: {e}"))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let path = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let authority = uri.authority().map(|a| a.as_str()).unwrap_or(&host);
    let request = Request::get(path)
        .header(header::HOST, authority)
        .header(header::RANGE, format!("bytes=0-{}", HEAD_BYTES - 1))
        .header(header::USER_AGENT, concat!("kubevirt-webgui/", env!("CARGO_PKG_VERSION")))
        .body(Empty::new())
        .map_err(|e| format!("could not build the request: {e}"))?;
    let response = sender.send_request(request).await.map_err(|e| format!("the request to {host} failed: {e}"))?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    // A server that ignores Range sends the whole file; read only the start.
    let mut body = response.into_body();
    let mut bytes = Vec::new();
    while (bytes.len() as u64) < HEAD_BYTES {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Some(data) = frame.data_ref() {
                    bytes.extend_from_slice(data);
                }
            }
            _ => break,
        }
    }
    Ok((status, headers, Bytes::from(bytes)))
}

/// Probe `url`, following redirects.
pub async fn probe(url: &str) -> Result<Probe, String> {
    let mut uri: Uri = url.trim().parse().map_err(|e| format!("not a URL: {e}"))?;
    for _ in 0..=MAX_REDIRECTS {
        let (status, headers, body) = tokio::time::timeout(TIMEOUT, fetch_head(&uri))
            .await
            .map_err(|_| "the server did not answer in time")??;
        match status {
            301 | 302 | 303 | 307 | 308 => {
                let location = headers
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("a redirect without a Location")?;
                uri = resolve(&uri, location)?;
            }
            200 | 206 => return Ok(describe(status, &headers, &body)),
            other => return Err(format!("the server answered {other}")),
        }
    }
    Err(format!("more than {MAX_REDIRECTS} redirects"))
}

fn resolve(base: &Uri, location: &str) -> Result<Uri, String> {
    let next: Uri = location.parse().map_err(|e| format!("bad redirect {location}: {e}"))?;
    if next.scheme().is_some() {
        return Ok(next);
    }
    let mut parts = base.clone().into_parts();
    parts.path_and_query = next.path_and_query().cloned();
    Uri::from_parts(parts).map_err(|e| format!("bad redirect {location}: {e}"))
}

fn header_u64(headers: &http::HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn describe(status: u16, headers: &http::HeaderMap, body: &[u8]) -> Probe {
    // `Content-Range: bytes 0-65535/8921073664` carries the whole length.
    let file_size = if status == 206 {
        header_u64(headers, header::CONTENT_RANGE).and_then(|r| r.rsplit('/').next()).and_then(|t| t.parse().ok())
    } else {
        header_u64(headers, header::CONTENT_LENGTH).and_then(|l| l.parse().ok())
    };
    let format = sniff(body);
    let virtual_size = match format {
        "qcow2" => body.get(24..32).map(|b| u64::from_be_bytes(b.try_into().unwrap())),
        "raw" | "iso" => file_size,
        _ => None,
    };
    Probe { file_size, virtual_size, format: format.into() }
}

/// The format of an image from its first bytes.
fn sniff(head: &[u8]) -> &'static str {
    let starts = |magic: &[u8]| head.starts_with(magic);
    if starts(b"QFI\xfb") {
        "qcow2"
    } else if starts(b"\xfd7zXZ\x00") {
        "xz"
    } else if starts(b"\x1f\x8b") {
        "gzip"
    } else if starts(b"\x28\xb5\x2f\xfd") {
        "zstd"
    } else if starts(b"KDMV") || starts(b"# Disk DescriptorFile") {
        "vmdk"
    } else if starts(b"vhdxfile") {
        "vhdx"
    } else if starts(b"conectix") {
        "vhd"
    } else if head.get(0x8001..0x8006) == Some(b"CD001") {
        // ISO 9660's primary volume descriptor, at sector 16.
        "iso"
    } else {
        "raw"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_qcow2_virtual_size() {
        let mut head = b"QFI\xfb\x00\x00\x00\x03".to_vec();
        head.resize(32, 0);
        head[24..32].copy_from_slice(&(20u64 << 30).to_be_bytes());
        let mut headers = http::HeaderMap::new();
        headers.insert(header::CONTENT_RANGE, "bytes 0-31/123456789".parse().unwrap());
        let p = describe(206, &headers, &head);
        assert_eq!(p, Probe { file_size: Some(123456789), virtual_size: Some(20 << 30), format: "qcow2".into() });
    }

    #[test]
    fn an_iso_is_its_own_size() {
        let mut head = vec![0u8; 0x8010];
        head[0x8001..0x8006].copy_from_slice(b"CD001");
        let mut headers = http::HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, "8921073664".parse().unwrap());
        let p = describe(200, &headers, &head);
        assert_eq!((p.format.as_str(), p.virtual_size), ("iso", Some(8921073664)));
    }

    #[test]
    fn compressed_images_have_no_known_virtual_size() {
        let p = describe(206, &http::HeaderMap::new(), b"\xfd7zXZ\x00rest");
        assert_eq!((p.format.as_str(), p.virtual_size), ("xz", None));
    }

    #[test]
    fn relative_redirects_keep_the_host() {
        let next = resolve(&"https://a.example/x/y".parse().unwrap(), "/z?q=1").unwrap();
        assert_eq!(next.to_string(), "https://a.example/z?q=1");
    }
}
