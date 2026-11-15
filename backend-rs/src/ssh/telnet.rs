/// Minimal Telnet client over raw TCP.
///
/// Negotiates NAWS (window size) and passes data bi-directionally.
/// Does NOT implement full RFC 854 — just enough for interactive terminals.
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::debug;

// Telnet command bytes.
const IAC: u8 = 255;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;
const SB: u8 = 250;
const SE: u8 = 240;
const NAWS: u8 = 31;
const ECHO: u8 = 1;
const SGA: u8 = 3; // Suppress Go Ahead
const TTYPE: u8 = 24; // Terminal Type
const IS: u8 = 0;
const SEND: u8 = 1;

pub struct TelnetClient {
    stream: TcpStream,
    cols: u16,
    rows: u16,
    term_type: String,
}

impl TelnetClient {
    pub async fn connect(
        host: &str,
        port: u16,
        cols: u16,
        rows: u16,
        term_type: &str,
        timeout: std::time::Duration,
    ) -> std::io::Result<Self> {
        let stream = tokio::time::timeout(timeout, TcpStream::connect((host, port)))
            .await
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "connection timed out")
            })??;
        stream.set_nodelay(true)?;
        Ok(Self {
            stream,
            cols,
            rows,
            term_type: term_type.to_string(),
        })
    }

    /// Split into read/write halves.  The caller owns the I/O loops.
    pub fn into_split(self) -> (TelnetReader, TelnetWriter) {
        let (rd, wr) = tokio::io::split(self.stream);
        (
            TelnetReader {
                inner: rd,
                parser: TelnetParser::new(self.cols, self.rows, self.term_type),
            },
            TelnetWriter {
                inner: wr,
                cols: self.cols,
                rows: self.rows,
            },
        )
    }
}

const MAX_SUBNEGOTIATION_BYTES: usize = 4096;
#[derive(Default)]
enum ParseState {
    #[default]
    Data,
    Iac,
    Option(u8),
    Subnegotiation {
        data: Vec<u8>,
        escaped: bool,
    },
}
struct TelnetParser {
    state: ParseState,
    cols: u16,
    rows: u16,
    term_type: String,
}
pub struct TelnetReader {
    inner: tokio::io::ReadHalf<TcpStream>,
    parser: TelnetParser,
}
impl TelnetReader {
    pub async fn read(&mut self) -> std::io::Result<(Vec<u8>, Vec<Vec<u8>>)> {
        let mut raw = [0u8; 8192];
        let n = self.inner.read(&mut raw).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "telnet connection closed",
            ));
        }
        self.parser.feed(&raw[..n])
    }
}
impl TelnetParser {
    fn new(cols: u16, rows: u16, term_type: String) -> Self {
        Self {
            state: ParseState::Data,
            cols,
            rows,
            term_type,
        }
    }
    fn feed(&mut self, input: &[u8]) -> std::io::Result<(Vec<u8>, Vec<Vec<u8>>)> {
        let mut output = Vec::with_capacity(input.len());
        let mut responses = Vec::new();
        for &byte in input {
            self.state = match std::mem::take(&mut self.state) {
                ParseState::Data if byte == IAC => ParseState::Iac,
                ParseState::Data => {
                    output.push(byte);
                    ParseState::Data
                }
                ParseState::Iac => match byte {
                    IAC => {
                        output.push(IAC);
                        ParseState::Data
                    }
                    DO | DONT | WILL | WONT => ParseState::Option(byte),
                    SB => ParseState::Subnegotiation {
                        data: Vec::new(),
                        escaped: false,
                    },
                    _ => ParseState::Data,
                },
                ParseState::Option(command) => {
                    match command {
                        DO => responses.extend(self.make_do_responses(byte)),
                        DONT => responses.push(vec![IAC, WONT, byte]),
                        WILL => responses.extend(self.make_will_responses(byte)),
                        _ => {}
                    }
                    ParseState::Data
                }
                ParseState::Subnegotiation { mut data, escaped } => {
                    if escaped && byte == SE {
                        if data.starts_with(&[TTYPE, SEND]) {
                            let mut response = vec![IAC, SB, TTYPE, IS];
                            append_escaped(&mut response, self.term_type.as_bytes());
                            response.extend_from_slice(&[IAC, SE]);
                            responses.push(response);
                        }
                        ParseState::Data
                    } else if !escaped && byte == IAC {
                        ParseState::Subnegotiation {
                            data,
                            escaped: true,
                        }
                    } else {
                        if data.len() >= MAX_SUBNEGOTIATION_BYTES {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "Telnet subnegotiation exceeds 4096 bytes",
                            ));
                        }
                        data.push(byte);
                        ParseState::Subnegotiation {
                            data,
                            escaped: false,
                        }
                    }
                }
            };
        }
        Ok((output, responses))
    }

    /// Build responses for a DO request (synchronous — no I/O).
    fn make_do_responses(&self, opt: u8) -> Vec<Vec<u8>> {
        let mut r = Vec::new();
        match opt {
            NAWS => {
                r.push(vec![IAC, WILL, NAWS]);
                let mut naws = vec![IAC, SB, NAWS];
                append_escaped(&mut naws, &self.cols.to_be_bytes());
                append_escaped(&mut naws, &self.rows.to_be_bytes());
                naws.extend_from_slice(&[IAC, SE]);
                r.push(naws);
            }
            TTYPE => {
                r.push(vec![IAC, WILL, TTYPE]);
                // Proactively send terminal type (some servers don't send SB TTYPE SEND).
                let mut sb = vec![IAC, SB, TTYPE, IS];
                append_escaped(&mut sb, self.term_type.as_bytes());
                sb.extend_from_slice(&[IAC, SE]);
                r.push(sb);
            }
            SGA => {
                r.push(vec![IAC, WILL, SGA]);
            }
            _ => {
                r.push(vec![IAC, WONT, opt]);
                debug!("telnet: refused DO {opt}");
            }
        }
        r
    }

    /// Build responses for a WILL notification (synchronous — no I/O).
    fn make_will_responses(&self, opt: u8) -> Vec<Vec<u8>> {
        match opt {
            ECHO | SGA => vec![vec![IAC, DO, opt]],
            _ => vec![vec![IAC, DONT, opt]],
        }
    }
}

pub struct TelnetWriter {
    inner: tokio::io::WriteHalf<TcpStream>,
    pub cols: u16,
    pub rows: u16,
}

impl TelnetWriter {
    /// Send user data with RFC 854 CR→CRLF conversion.
    ///
    /// Network devices (Cisco, GPON, MikroTik, etc.) expect CRLF line endings
    /// in Telnet mode.  xterm.js sends bare CR for Enter, so we append LF.
    pub async fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(data.len() + 8);
        for j in 0..data.len() {
            buf.push(data[j]);
            if data[j] == IAC {
                buf.push(IAC);
            }
            if data[j] == b'\r' {
                let next = data.get(j + 1).copied();
                if next != Some(b'\n') && next != Some(0) {
                    buf.push(b'\n');
                }
            }
        }
        self.inner.write_all(&buf).await?;
        self.inner.flush().await
    }

    /// Send a telnet command sequence.
    pub async fn send_cmd(&mut self, cmd: &[u8]) -> std::io::Result<()> {
        self.inner.write_all(cmd).await?;
        self.inner.flush().await
    }

    /// Send NAWS (RFC 1073) subnegotiation.
    pub async fn send_naws(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.cols = cols;
        self.rows = rows;
        let mut buf = vec![IAC, SB, NAWS];
        append_escaped(&mut buf, &cols.to_be_bytes());
        append_escaped(&mut buf, &rows.to_be_bytes());
        buf.extend_from_slice(&[IAC, SE]);
        self.send_cmd(&buf).await
    }

    /// Shut down the write half.
    pub async fn shutdown(&mut self) {
        let _ = self.inner.shutdown().await;
    }
}

fn append_escaped(output: &mut Vec<u8>, input: &[u8]) {
    for &byte in input {
        output.push(byte);
        if byte == IAC {
            output.push(IAC);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negotiation_is_identical_at_every_tcp_boundary() {
        let bytes = [
            b'a', IAC, DO, NAWS, IAC, SB, TTYPE, SEND, IAC, SE, IAC, IAC, b'z',
        ];
        let expected = TelnetParser::new(255, 24, "xterm".into())
            .feed(&bytes)
            .unwrap();
        for split in 0..=bytes.len() {
            let mut parser = TelnetParser::new(255, 24, "xterm".into());
            let (mut visible, mut replies) = parser.feed(&bytes[..split]).unwrap();
            let (rest, responses) = parser.feed(&bytes[split..]).unwrap();
            visible.extend(rest);
            replies.extend(responses);
            assert_eq!((visible, replies), expected, "split at {split}");
        }
        let mut parser = TelnetParser::new(255, 24, "xterm".into());
        let (mut visible, mut replies) = (Vec::new(), Vec::new());
        for byte in bytes {
            let (data, responses) = parser.feed(&[byte]).unwrap();
            visible.extend(data);
            replies.extend(responses);
        }
        assert_eq!((visible, replies), expected);
        assert_eq!(expected.0, [b'a', IAC, b'z']);
        assert_eq!(expected.1[1], [IAC, SB, NAWS, 0, IAC, IAC, 0, 24, IAC, SE]);
    }
    #[test]
    fn subnegotiation_is_bounded_and_escaped_bytes_stay_out_of_text() {
        let mut parser = TelnetParser::new(80, 24, "xterm".into());
        parser.feed(&[IAC, SB, TTYPE]).unwrap();
        assert!(parser.feed(&vec![b'x'; MAX_SUBNEGOTIATION_BYTES]).is_err());
        let mut parser = TelnetParser::new(80, 24, "xterm".into());
        let (visible, _) = parser
            .feed(&[IAC, SB, 99, IAC, IAC, IAC, SE, b'x'])
            .unwrap();
        assert_eq!(visible, b"x");
    }
}
