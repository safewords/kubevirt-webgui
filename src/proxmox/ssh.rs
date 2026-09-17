//! SSH to a Proxmox VE host.
//!
//! The host key is pinned: a first connection only reads the key, the person
//! compares its fingerprint with the host's (`ssh-keygen -lf
//! /etc/ssh/ssh_host_ed25519_key.pub`), and every later connection refuses a
//! different key before any credential is sent.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// A host key, as `ssh-keygen -l` shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    pub algorithm: String,
    /// `SHA256:…`
    pub fingerprint: String,
}

/// How to sign in.
pub enum Auth {
    Password(SecretString),
    Key { pem: SecretString, passphrase: Option<SecretString> },
}

/// Where to connect, already checked against the allow-list.
#[derive(Debug, Clone)]
pub struct Target {
    /// What the person typed, for messages.
    pub host: String,
    pub addr: SocketAddr,
    pub user: String,
}

struct Pinned {
    expected: Option<String>,
    seen: Arc<Mutex<Option<HostKey>>>,
}

fn host_key(key: &PublicKeyOrCertificate) -> HostKey {
    let public = match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
        PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
    };
    HostKey { algorithm: public.algorithm().to_string(), fingerprint: public.fingerprint(HashAlg::Sha256).to_string() }
}

impl client::Handler for Pinned {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = host_key(key);
        let accepted = self.expected.as_deref() == Some(key.fingerprint.as_str());
        *self.seen.lock().unwrap() = Some(key);
        // Without an expected fingerprint this is a probe: read the key, then hang up.
        Ok(accepted)
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 6,
        nodelay: true,
        // Disk streams: larger windows mean fewer round trips.
        window_size: 16 * 1024 * 1024,
        channel_buffer_size: 256,
        ..Default::default()
    })
}

/// Read a host's key without signing in.
pub async fn probe(addr: SocketAddr, host: &str) -> Result<HostKey, String> {
    let seen = Arc::new(Mutex::new(None));
    let handler = Pinned { expected: None, seen: seen.clone() };
    let attempt = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config(), addr, handler)).await;
    if attempt.is_err() {
        return Err(format!("{host} ({addr}) did not answer within {}s", CONNECT_TIMEOUT.as_secs()));
    }
    let key = seen.lock().unwrap().clone();
    match (key, attempt) {
        (Some(key), _) => Ok(key),
        (None, Ok(Err(e))) => Err(format!("could not reach SSH on {host} ({addr}): {e}")),
        (None, _) => Err(format!("{host} ({addr}) sent no host key")),
    }
}

/// An authenticated connection.
pub struct Ssh {
    handle: Handle<Pinned>,
}

/// A finished command.
#[derive(Debug)]
pub struct Output {
    pub status: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

impl Ssh {
    /// Connect, insisting on `fingerprint`, and sign in.
    pub async fn connect(target: &Target, auth: &Auth, fingerprint: &str) -> Result<Self, String> {
        let seen = Arc::new(Mutex::new(None));
        let handler = Pinned { expected: Some(fingerprint.to_string()), seen: seen.clone() };
        let host = &target.host;
        let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config(), target.addr, handler))
            .await
        {
            Err(_) => return Err(format!("{host} did not answer within {}s", CONNECT_TIMEOUT.as_secs())),
            Ok(Ok(handle)) => handle,
            Ok(Err(e)) => {
                return Err(match seen.lock().unwrap().clone() {
                    Some(key) if key.fingerprint != fingerprint => format!(
                        "{host}'s host key has changed: it is now {} {}, not the {fingerprint} you accepted — refusing to send credentials",
                        key.algorithm, key.fingerprint
                    ),
                    _ => format!("could not connect to {host}: {e}"),
                });
            }
        };

        let user = target.user.clone();
        let result = match auth {
            Auth::Password(password) => handle.authenticate_password(user.clone(), password.expose_secret()).await,
            Auth::Key { pem, passphrase } => {
                let key =
                    russh::keys::decode_secret_key(pem.expose_secret(), passphrase.as_ref().map(|p| p.expose_secret()))
                        .map_err(|e| format!("the private key could not be read: {e}"))?;
                let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
                handle.authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
            }
        }
        .map_err(|e| format!("signing in to {host} failed: {e}"))?;
        if !result.success() {
            return Err(format!("{host} refused the credentials for {user}"));
        }
        Ok(Self { handle })
    }

    /// Start a command; the caller reads its channel.
    pub async fn exec(&self, command: &str) -> Result<russh::Channel<client::Msg>, String> {
        let channel = self.handle.channel_open_session().await.map_err(|e| format!("could not open a session: {e}"))?;
        channel.exec(true, command).await.map_err(|e| format!("could not run the command: {e}"))?;
        Ok(channel)
    }

    /// Run a command to completion, keeping at most `limit` bytes of output.
    pub async fn run(&self, command: &str, limit: usize) -> Result<Output, String> {
        let mut channel = self.exec(command).await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if stdout.len() + data.len() > limit {
                        return Err(format!("the command printed more than {} MiB", limit / (1024 * 1024)));
                    }
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if stderr.len() < 64 * 1024 {
                        stderr.extend_from_slice(&data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
        Ok(Output { status, stdout, stderr: String::from_utf8_lossy(&stderr).trim().to_string() })
    }

    pub async fn close(self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}

/// `value` as one word for a POSIX shell.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_single_quotes() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("a b; rm -rf /"), "'a b; rm -rf /'");
    }
}
