use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub(crate) const BRIDGE_ARGUMENT: &str = "--ssh-automation-mcp";
pub(crate) const ENDPOINT_ENV: &str = "SLEEKSSH_AUTOMATION_ENDPOINT";
pub(crate) const TOKEN_ENV: &str = "SLEEKSSH_AUTOMATION_TOKEN";
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_CLIENTS: usize = 4;
const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(250);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

type Handler = Arc<dyn Fn(Value) -> Option<Value> + Send + Sync>;

pub(crate) struct BridgeServer {
    pub(crate) endpoint: SocketAddr,
    stopped: Arc<AtomicBool>,
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

pub(crate) fn serve(
    token: String,
    cancelled: Arc<AtomicBool>,
    handler: Handler,
) -> Result<BridgeServer, String> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Failed to start automation bridge: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let endpoint = listener.local_addr().map_err(|error| error.to_string())?;
    let stopped = Arc::new(AtomicBool::new(false));
    let server_stopped = Arc::clone(&stopped);
    std::thread::spawn(move || {
        let clients = Arc::new(AtomicUsize::new(0));
        while !server_stopped.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, peer)) => {
                    if !peer.ip().is_loopback() || clients.load(Ordering::Acquire) >= MAX_CLIENTS {
                        continue;
                    }
                    clients.fetch_add(1, Ordering::AcqRel);
                    let active_clients = Arc::clone(&clients);
                    let client_token = token.clone();
                    let client_stopped = Arc::clone(&server_stopped);
                    let client_cancelled = Arc::clone(&cancelled);
                    let client_handler = Arc::clone(&handler);
                    std::thread::spawn(move || {
                        if let Err(error) = serve_client(
                            stream,
                            &client_token,
                            &client_stopped,
                            &client_cancelled,
                            &client_handler,
                        ) {
                            eprintln!("Automation bridge connection closed: {error}");
                        }
                        active_clients.fetch_sub(1, Ordering::AcqRel);
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(ACCEPT_POLL_INTERVAL)
                }
                Err(error) => {
                    eprintln!("Automation bridge failed: {error}");
                    server_stopped.store(true, Ordering::Release);
                }
            }
        }
    });
    Ok(BridgeServer { endpoint, stopped })
}

fn serve_client(
    mut stream: TcpStream,
    token: &str,
    stopped: &AtomicBool,
    cancelled: &AtomicBool,
    handler: &Handler,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(SOCKET_POLL_INTERVAL))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    while let Some(message) = read_message(&mut reader, || {
        stopped.load(Ordering::Acquire) || cancelled.load(Ordering::Acquire)
    })? {
        let envelope: Value =
            serde_json::from_slice(&message).map_err(|_| "Invalid bridge message".to_string())?;
        if envelope.get("token").and_then(Value::as_str) != Some(token) {
            return Err("Invalid automation bridge token".to_string());
        }
        let request = envelope
            .get("request")
            .ok_or("Missing bridge request")?
            .clone();
        let response = handler(request).unwrap_or(Value::Null);
        write_message(&mut stream, &response)?;
    }
    Ok(())
}

fn read_message(
    reader: &mut impl BufRead,
    stopped: impl Fn() -> bool,
) -> Result<Option<Vec<u8>>, String> {
    let mut message = Vec::new();
    loop {
        if stopped() {
            return Ok(None);
        }
        let buffer = match reader.fill_buf() {
            Ok(buffer) => buffer,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(error) => return Err(format!("Failed to read automation message: {error}")),
        };
        if buffer.is_empty() {
            return if message.is_empty() {
                Ok(None)
            } else {
                Err("Incomplete automation message".to_string())
            };
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = end.map_or(buffer.len(), |position| position + 1);
        if message.len() + consumed > MAX_MESSAGE_BYTES {
            return Err("Automation message exceeds size limit".to_string());
        }
        message.extend_from_slice(&buffer[..consumed]);
        reader.consume(consumed);
        if end.is_some() {
            return Ok(Some(message));
        }
    }
}

fn write_message(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, message).map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

pub(crate) fn run_stdio_bridge() -> Result<(), String> {
    let endpoint = std::env::var(ENDPOINT_ENV).map_err(|_| "Automation endpoint is missing")?;
    let endpoint = validate_endpoint(&endpoint)?;
    let token = std::env::var(TOKEN_ENV).map_err(|_| "Automation token is missing")?;
    let input = io::stdin();
    let output = io::stdout();
    proxy_stdio(input.lock(), output.lock(), endpoint, &token)
}

fn proxy_stdio(
    mut input: impl BufRead,
    mut output: impl Write,
    endpoint: SocketAddr,
    token: &str,
) -> Result<(), String> {
    const TOKEN_HEX_LENGTH: usize = 64;
    if token.len() != TOKEN_HEX_LENGTH || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid automation token".to_string());
    }
    let mut stream = TcpStream::connect_timeout(&endpoint, CONNECT_TIMEOUT)
        .map_err(|error| format!("Cannot connect to SleekSSH: {error}"))?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    while let Some(message) = read_message(&mut input, || false)? {
        let request: Value = serde_json::from_slice(&message)
            .map_err(|error| format!("Invalid MCP JSON: {error}"))?;
        write_message(&mut stream, &json!({"token": token, "request": request}))?;
        let response =
            read_message(&mut reader, || false)?.ok_or("SleekSSH automation bridge closed")?;
        let response: Value =
            serde_json::from_slice(&response).map_err(|error| error.to_string())?;
        if !response.is_null() {
            write_message(&mut output, &response)?;
        }
    }
    Ok(())
}

fn validate_endpoint(endpoint: &str) -> Result<SocketAddr, String> {
    let address: SocketAddr = endpoint
        .parse()
        .map_err(|_| "Invalid automation endpoint")?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err("Automation endpoint must be a local loopback address".to_string());
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn endpoint_rejects_remote_or_invalid_addresses() {
        assert!(validate_endpoint("127.0.0.1:1234").is_ok());
        for endpoint in ["", "localhost:1234", "192.0.2.1:1234", "127.0.0.1:0"] {
            assert!(validate_endpoint(endpoint).is_err(), "{endpoint}");
        }
    }

    #[test]
    fn framing_handles_eof_cancellation_partial_and_oversized_messages() {
        assert!(read_message(&mut Cursor::new(b""), || false)
            .unwrap()
            .is_none());
        assert!(read_message(&mut Cursor::new(b"{}\n"), || true)
            .unwrap()
            .is_none());
        assert_eq!(
            read_message(&mut Cursor::new(b"{}\n"), || false)
                .unwrap()
                .unwrap(),
            b"{}\n"
        );
        assert!(read_message(&mut Cursor::new(b"{}"), || false).is_err());
        assert!(
            read_message(&mut Cursor::new(vec![b'x'; MAX_MESSAGE_BYTES + 1]), || {
                false
            })
            .is_err()
        );
    }

    #[test]
    fn bridge_authenticates_and_dispatches_only_valid_clients() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let server = serve(
            "secret".to_string(),
            cancelled,
            Arc::new(|request| Some(request)),
        )
        .unwrap();
        let mut stream = TcpStream::connect(server.endpoint).unwrap();
        stream.set_read_timeout(Some(CONNECT_TIMEOUT)).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        write_message(&mut stream, &json!({"token":"secret","request":{"id":1}})).unwrap();
        let response = read_message(&mut reader, || false).unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&response).unwrap(),
            json!({"id":1})
        );
        write_message(&mut stream, &json!({"token":"wrong","request":{"id":2}})).unwrap();
        assert!(read_message(&mut reader, || false).unwrap().is_none());
    }

    #[test]
    fn stdio_proxy_forwards_requests_without_notification_responses() {
        let token = "a".repeat(64);
        let server = serve(
            token.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(|request| {
                request
                    .get("id")
                    .map(|id| json!({"jsonrpc":"2.0","id":id,"result":{}}))
            }),
        )
        .unwrap();
        let input = Cursor::new(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n");
        let mut output = Vec::new();
        proxy_stdio(input, &mut output, server.endpoint, &token).unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["id"], 1);
        for token in ["", "bad", &"a".repeat(65), &"z".repeat(64)] {
            assert!(proxy_stdio(Cursor::new(b""), Vec::new(), server.endpoint, token).is_err());
        }
    }
}
