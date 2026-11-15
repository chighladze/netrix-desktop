use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use chrono::{TimeZone, Utc};
use russh::client;
use russh::keys::PublicKeyBase64;
use russh::keys::PublicKeyOrCertificate;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};
use zeroize::Zeroize;

mod connection;
mod operations;
use crate::ssh::sftp_transfers::Transfer;
pub use connection::SftpManager;

use crate::ssh::known_hosts::{HostKeyResult, KnownHostsStore};

#[derive(Clone)]
pub struct SftpProbeTarget {
    pub host_id: i64,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub connect_timeout_secs: u64,
}

#[derive(Debug, Clone)]
pub struct SftpListResult {
    pub path: String,
    pub entries: Vec<SftpDirectoryEntry>,
}

#[derive(Debug, Clone)]
pub struct SftpFileResult {
    pub path: String,
    pub filename: String,
    pub data: Vec<u8>,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct SftpUploadResult {
    pub path: String,
    pub size: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TemporaryState {
    Unused,
    Unconfirmed,
    Owned,
}

#[derive(Debug, Clone)]
pub struct SftpDirectoryEntry {
    pub name: String,
    pub path: String,
    pub entry_type: String,
    pub size: Option<i64>,
    pub modified_at: Option<String>,
    pub permissions: Option<String>,
}

#[derive(Debug, Clone)]
pub enum SftpProbeStatus {
    Supported,
    Unsupported(String),
}

#[derive(Debug, thiserror::Error)]
pub enum SftpProbeError {
    #[error("authentication failed")]
    AuthFailed,
    #[error("SSH host key mismatch")]
    HostKeyMismatch,
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("probe failed: {0}")]
    Probe(String),
}

impl Drop for SftpProbeTarget {
    fn drop(&mut self) {
        if let Some(secret) = &mut self.password {
            secret.zeroize();
        }
        if let Some(secret) = &mut self.private_key {
            secret.zeroize();
        }
        if let Some(secret) = &mut self.passphrase {
            secret.zeroize();
        }
    }
}

const SSH_FXP_INIT: u8 = 1;
const SSH_FXP_VERSION: u8 = 2;
const SSH_FXP_OPEN: u8 = 3;
const SSH_FXP_CLOSE: u8 = 4;
const SSH_FXP_READ: u8 = 5;
const SSH_FXP_WRITE: u8 = 6;
const SSH_FXP_OPENDIR: u8 = 11;
const SSH_FXP_READDIR: u8 = 12;
const SSH_FXP_REALPATH: u8 = 16;
const SSH_FXP_STATUS: u8 = 101;
const SSH_FXP_HANDLE: u8 = 102;
const SSH_FXP_DATA: u8 = 103;
const SSH_FXP_NAME: u8 = 104;

const SSH_FX_OK: u32 = 0;
const SSH_FX_EOF: u32 = 1;
const SSH_FX_NO_SUCH_FILE: u32 = 2;
const SSH_FX_PERMISSION_DENIED: u32 = 3;
const SSH_FILEXFER_ATTR_SIZE: u32 = 0x0000_0001;
const SSH_FILEXFER_ATTR_UIDGID: u32 = 0x0000_0002;
const SSH_FILEXFER_ATTR_PERMISSIONS: u32 = 0x0000_0004;
const SSH_FILEXFER_ATTR_ACMODTIME: u32 = 0x0000_0008;
const SSH_FILEXFER_ATTR_EXTENDED: u32 = 0x8000_0000;
const SSH_FXF_READ: u32 = 0x0000_0001;
const SSH_FXF_WRITE: u32 = 0x0000_0002;
const SSH_FXF_CREAT: u32 = 0x0000_0008;
const SSH_FXF_EXCL: u32 = 0x0000_0020;
const MAX_SFTP_PACKET_SIZE: u32 = 16 * 1024 * 1024;
const SFTP_READ_CHUNK_SIZE: u32 = 32 * 1024;
const SFTP_WRITE_CHUNK_SIZE: usize = 32 * 1024;

struct SftpV3Client<S> {
    stream: S,
    request_id: u32,
    posix_rename: bool,
    fsync: bool,
}

struct SftpPacket {
    packet_type: u8,
    payload: Vec<u8>,
}

#[derive(Default)]
struct SftpAttrs {
    size: Option<u64>,
    permissions: Option<u32>,
    modified_time: Option<u32>,
}

impl<S> SftpV3Client<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn new(stream: S) -> Self {
        Self {
            stream,
            request_id: 1,
            posix_rename: false,
            fsync: false,
        }
    }

    async fn init(&mut self) -> Result<(), String> {
        let mut payload = Vec::new();
        push_u32(&mut payload, 3);
        self.send_packet(SSH_FXP_INIT, &payload).await?;

        let packet = self.read_packet().await?;
        if packet.packet_type != SSH_FXP_VERSION {
            return Err(format!(
                "expected SFTP VERSION, got packet {}",
                packet.packet_type
            ));
        }

        let mut cursor = Cursor::new(packet.payload.as_slice());
        let version = read_u32(&mut cursor)?;
        if version != 3 {
            return Err(format!("remote SFTP version {version} is not supported"));
        }
        let mut extensions = 0;
        while (cursor.position() as usize) < packet.payload.len() {
            extensions += 1;
            if extensions > 128 {
                return Err("Too many SFTP extensions".into());
            }
            let name = read_string_bytes(&mut cursor)?;
            let version = read_string_bytes(&mut cursor)?;
            if name == b"posix-rename@openssh.com" && version == b"1" {
                self.posix_rename = true;
            }
            if name == b"fsync@openssh.com" && version == b"1" {
                self.fsync = true;
            }
        }
        Ok(())
    }

    async fn list_dir(&mut self, path: &str) -> Result<SftpListResult, String> {
        let canonical_path = self.realpath(path).await?;
        let handle = self.opendir(&canonical_path).await?;
        let entries_result = self.readdir_all(&handle, &canonical_path).await;
        let close_result = self.close(&handle).await;

        let mut entries = entries_result?;
        close_result?;
        entries.sort_by(|a, b| {
            let a_dir = a.entry_type == "directory";
            let b_dir = b.entry_type == "directory";
            b_dir
                .cmp(&a_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(SftpListResult {
            path: canonical_path,
            entries,
        })
    }

    async fn read_file(
        &mut self,
        path: &str,
        max_bytes: usize,
        allow_truncate: bool,
    ) -> Result<SftpFileResult, String> {
        if max_bytes == 0 {
            return Err("SFTP read limit must be greater than zero".into());
        }

        let canonical_path = self.realpath(path).await?;
        let handle = self.open_file(&canonical_path).await?;
        let data_result = self.read_all(&handle, max_bytes, allow_truncate).await;
        let close_result = self.close(&handle).await;

        let (data, truncated) = data_result?;
        close_result?;
        Ok(SftpFileResult {
            filename: filename_from_remote_path(&canonical_path),
            path: canonical_path,
            data,
            truncated,
        })
    }

    async fn realpath(&mut self, path: &str) -> Result<String, String> {
        let request_id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, request_id);
        push_string(&mut payload, path.as_bytes())?;
        self.send_packet(SSH_FXP_REALPATH, &payload).await?;

        let response = self.read_response(request_id).await?;
        if response.packet_type == SSH_FXP_STATUS {
            return Err(status_error(&response.payload)?);
        }
        if response.packet_type != SSH_FXP_NAME {
            return Err(format!(
                "expected REALPATH NAME, got packet {}",
                response.packet_type
            ));
        }

        let mut cursor = Cursor::new(response.payload.as_slice());
        let count = read_u32(&mut cursor)?;
        if count != 1 {
            return Err("Invalid SFTP REALPATH response count".into());
        }
        let filename = read_utf8_string(&mut cursor, 4096)?;
        if filename.is_empty() || filename.contains('\0') {
            return Err("Invalid remote canonical path".into());
        }
        Ok(filename)
    }

    async fn opendir(&mut self, path: &str) -> Result<Vec<u8>, String> {
        let request_id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, request_id);
        push_string(&mut payload, path.as_bytes())?;
        self.send_packet(SSH_FXP_OPENDIR, &payload).await?;

        let response = self.read_response(request_id).await?;
        if response.packet_type == SSH_FXP_STATUS {
            return Err(status_error(&response.payload)?);
        }
        if response.packet_type != SSH_FXP_HANDLE {
            return Err(format!(
                "expected OPENDIR HANDLE, got packet {}",
                response.packet_type
            ));
        }

        let mut cursor = Cursor::new(response.payload.as_slice());
        read_file_handle(&mut cursor)
    }

    async fn open_file(&mut self, path: &str) -> Result<Vec<u8>, String> {
        let request_id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, request_id);
        push_string(&mut payload, path.as_bytes())?;
        push_u32(&mut payload, SSH_FXF_READ);
        push_u32(&mut payload, 0);
        self.send_packet(SSH_FXP_OPEN, &payload).await?;

        let response = self.read_response(request_id).await?;
        if response.packet_type == SSH_FXP_STATUS {
            return Err(status_error(&response.payload)?);
        }
        if response.packet_type != SSH_FXP_HANDLE {
            return Err(format!(
                "expected OPEN HANDLE, got packet {}",
                response.packet_type
            ));
        }

        let mut cursor = Cursor::new(response.payload.as_slice());
        read_file_handle(&mut cursor)
    }

    async fn read_all(
        &mut self,
        handle: &[u8],
        max_bytes: usize,
        allow_truncate: bool,
    ) -> Result<(Vec<u8>, bool), String> {
        let mut data = Vec::new();
        let mut offset = 0u64;

        loop {
            let chunk = self
                .read_chunk(handle, offset, SFTP_READ_CHUNK_SIZE)
                .await?;
            let Some(chunk) = chunk else {
                return Ok((data, false));
            };
            if chunk.is_empty() {
                return Err("Empty SFTP data without EOF".into());
            }

            let remaining = max_bytes.saturating_sub(data.len());
            if chunk.len() > remaining {
                if allow_truncate && remaining > 0 {
                    data.extend_from_slice(&chunk[..remaining]);
                    return Ok((data, true));
                }
                return Err(format!(
                    "Remote file is larger than the configured {} byte read limit",
                    max_bytes
                ));
            }

            data.extend_from_slice(&chunk);
            offset = offset
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "SFTP file offset overflow".to_string())?;

            if data.len() == max_bytes && allow_truncate {
                let extra = self.read_chunk(handle, offset, 1).await?;
                return Ok((data, extra.is_some_and(|bytes| !bytes.is_empty())));
            }
        }
    }

    async fn read_chunk(
        &mut self,
        handle: &[u8],
        offset: u64,
        len: u32,
    ) -> Result<Option<Vec<u8>>, String> {
        let request_id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, request_id);
        push_string(&mut payload, handle)?;
        push_u64(&mut payload, offset);
        push_u32(&mut payload, len);
        self.send_packet(SSH_FXP_READ, &payload).await?;

        let response = self.read_response(request_id).await?;
        match response.packet_type {
            SSH_FXP_DATA => {
                let mut cursor = Cursor::new(response.payload.as_slice());
                let data = read_string_bytes(&mut cursor)?;
                if data.len() > len as usize {
                    return Err("SFTP server returned more data than requested".into());
                }
                Ok(Some(data))
            }
            SSH_FXP_STATUS => {
                let (code, message) = parse_status(&response.payload)?;
                if code == SSH_FX_EOF {
                    Ok(None)
                } else {
                    Err(status_message(code, &message))
                }
            }
            other => Err(format!("expected READ DATA or STATUS, got packet {other}")),
        }
    }

    async fn readdir_all(
        &mut self,
        handle: &[u8],
        parent_path: &str,
    ) -> Result<Vec<SftpDirectoryEntry>, String> {
        let mut entries = Vec::new();
        let mut listing_bytes = 0usize;

        loop {
            let request_id = self.next_request_id();
            let mut payload = Vec::new();
            push_u32(&mut payload, request_id);
            push_string(&mut payload, handle)?;
            self.send_packet(SSH_FXP_READDIR, &payload).await?;

            let response = self.read_response(request_id).await?;
            match response.packet_type {
                SSH_FXP_NAME => {
                    if response.payload.get(..4) == Some(&[0, 0, 0, 0]) {
                        return Err("Empty directory batch without EOF".into());
                    }
                    let batch = parse_name_entries(&response.payload, parent_path)?;
                    listing_bytes += batch
                        .iter()
                        .map(|entry| entry.path.len() + entry.name.len() + 128)
                        .sum::<usize>();
                    if listing_bytes > 16 * 1024 * 1024 {
                        return Err("Directory metadata exceeds 16 MiB".into());
                    }
                    entries.extend(batch);
                    if entries.len() > 100_000 {
                        return Err("Directory exceeds the 100,000 entry limit".into());
                    }
                }
                SSH_FXP_STATUS => {
                    let (code, message) = parse_status(&response.payload)?;
                    if code == SSH_FX_EOF {
                        break;
                    }
                    return Err(status_message(code, &message));
                }
                other => {
                    return Err(format!(
                        "expected READDIR NAME or STATUS, got packet {other}"
                    ))
                }
            }
        }

        Ok(entries)
    }

    async fn close(&mut self, handle: &[u8]) -> Result<(), String> {
        let request_id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, request_id);
        push_string(&mut payload, handle)?;
        self.send_packet(SSH_FXP_CLOSE, &payload).await?;

        let response = self.read_response(request_id).await?;
        if response.packet_type == SSH_FXP_STATUS {
            let (code, message) = parse_status(&response.payload)?;
            if code == SSH_FX_OK {
                return Ok(());
            }
            return Err(status_message(code, &message));
        }
        Err(format!(
            "expected CLOSE STATUS, got packet {}",
            response.packet_type
        ))
    }

    fn next_request_id(&mut self) -> u32 {
        let id = self.request_id;
        self.request_id = self.request_id.wrapping_add(1).max(1);
        id
    }

    async fn send_packet(&mut self, packet_type: u8, payload: &[u8]) -> Result<(), String> {
        let length = 1usize
            .checked_add(payload.len())
            .ok_or_else(|| "SFTP packet length overflow".to_string())?;
        if length > MAX_SFTP_PACKET_SIZE as usize {
            return Err("SFTP packet is too large".into());
        }

        let mut packet = Vec::with_capacity(4 + length);
        push_u32(&mut packet, length as u32);
        packet.push(packet_type);
        packet.extend_from_slice(payload);

        tokio::time::timeout(Duration::from_secs(30), self.stream.write_all(&packet))
            .await
            .map_err(|_| "SFTP write stalled for 30 seconds".to_string())?
            .map_err(|error| format!("SFTP write failed: {error}"))?;
        tokio::time::timeout(Duration::from_secs(30), self.stream.flush())
            .await
            .map_err(|_| "SFTP flush stalled for 30 seconds".to_string())?
            .map_err(|error| format!("SFTP flush failed: {error}"))
    }

    async fn read_packet(&mut self) -> Result<SftpPacket, String> {
        let mut len_buf = [0u8; 4];
        tokio::time::timeout(
            Duration::from_secs(30),
            self.stream.read_exact(&mut len_buf),
        )
        .await
        .map_err(|_| "SFTP read stalled for 30 seconds".to_string())?
        .map_err(|error| format!("SFTP read failed: {error}"))?;
        let length = u32::from_be_bytes(len_buf);
        if length == 0 || length > MAX_SFTP_PACKET_SIZE {
            return Err(format!("invalid SFTP packet length {length}"));
        }

        let mut body = vec![0u8; length as usize];
        tokio::time::timeout(Duration::from_secs(30), self.stream.read_exact(&mut body))
            .await
            .map_err(|_| "SFTP packet stalled for 30 seconds".to_string())?
            .map_err(|error| format!("SFTP packet read failed: {error}"))?;

        Ok(SftpPacket {
            packet_type: body[0],
            payload: body[1..].to_vec(),
        })
    }

    async fn read_response(&mut self, expected_id: u32) -> Result<SftpPacket, String> {
        let packet = self.read_packet().await?;
        let mut cursor = Cursor::new(packet.payload.as_slice());
        let response_id = read_u32(&mut cursor)?;
        if response_id != expected_id {
            return Err(format!(
                "unexpected SFTP response id {response_id}, expected {expected_id}"
            ));
        }

        let offset = cursor.position() as usize;
        Ok(SftpPacket {
            packet_type: packet.packet_type,
            payload: packet.payload[offset..].to_vec(),
        })
    }
}

fn parse_name_entries(
    payload: &[u8],
    parent_path: &str,
) -> Result<Vec<SftpDirectoryEntry>, String> {
    let mut cursor = Cursor::new(payload);
    let count = read_u32(&mut cursor)?;
    if count > 10_000 {
        return Err(format!(
            "remote returned too many directory entries ({count})"
        ));
    }

    let mut entries = Vec::new();
    let mut listing_bytes = 0usize;
    for _ in 0..count {
        let name = read_utf8_string(&mut cursor, 4096)?;
        let longname = read_utf8_string(&mut cursor, 16 * 1024)?;
        let attrs = read_attrs(&mut cursor)?;
        if name == "." || name == ".." {
            continue;
        }
        if name.is_empty() || name.contains('/') || name.contains('\0') {
            return Err("Remote directory contains an invalid or unsupported file name".into());
        }

        let entry_type = entry_type_from_permissions(attrs.permissions)
            .or_else(|| entry_type_from_longname(&longname))
            .unwrap_or_else(|| "other".into());
        let modified_at = attrs.modified_time.and_then(|seconds| {
            Utc.timestamp_opt(seconds as i64, 0)
                .single()
                .map(|dt| dt.to_rfc3339())
        });

        let path = join_remote_path(parent_path, &name);
        if path.len() > 4096 {
            return Err("Remote file path exceeds 4096 bytes".into());
        }
        listing_bytes += path.len() + name.len() + 128;
        if listing_bytes > 16 * 1024 * 1024 {
            return Err("Directory metadata exceeds 16 MiB".into());
        }
        entries.push(SftpDirectoryEntry {
            path,
            name,
            entry_type,
            size: attrs.size.and_then(|size| i64::try_from(size).ok()),
            modified_at,
            permissions: attrs.permissions.map(format_permissions),
        });
    }
    Ok(entries)
}

fn read_attrs(cursor: &mut Cursor<&[u8]>) -> Result<SftpAttrs, String> {
    let flags = read_u32(cursor)?;
    let mut attrs = SftpAttrs::default();

    if flags & SSH_FILEXFER_ATTR_SIZE != 0 {
        attrs.size = Some(read_u64(cursor)?);
    }
    if flags & SSH_FILEXFER_ATTR_UIDGID != 0 {
        let _uid = read_u32(cursor)?;
        let _gid = read_u32(cursor)?;
    }
    if flags & SSH_FILEXFER_ATTR_PERMISSIONS != 0 {
        attrs.permissions = Some(read_u32(cursor)?);
    }
    if flags & SSH_FILEXFER_ATTR_ACMODTIME != 0 {
        let _atime = read_u32(cursor)?;
        attrs.modified_time = Some(read_u32(cursor)?);
    }
    if flags & SSH_FILEXFER_ATTR_EXTENDED != 0 {
        let count = read_u32(cursor)?;
        if count > 128 {
            return Err("Too many SFTP attribute extensions".into());
        }
        for _ in 0..count {
            let _type = read_string_bytes(cursor)?;
            let _data = read_string_bytes(cursor)?;
        }
    }

    Ok(attrs)
}

fn parse_status(payload: &[u8]) -> Result<(u32, String), String> {
    let mut cursor = Cursor::new(payload);
    let code = read_u32(&mut cursor)?;
    let message = read_string_lossy(&mut cursor).unwrap_or_default();
    Ok((code, message.chars().take(4096).collect()))
}

fn status_error(payload: &[u8]) -> Result<String, String> {
    let (code, message) = parse_status(payload)?;
    Ok(status_message(code, &message))
}

fn status_message(code: u32, message: &str) -> String {
    let detail = message.trim();
    match code {
        SSH_FX_EOF => "End of directory".into(),
        SSH_FX_NO_SUCH_FILE => "Remote path does not exist".into(),
        SSH_FX_PERMISSION_DENIED => "Permission denied for remote path".into(),
        _ if detail.is_empty() => format!("SFTP server returned status code {code}"),
        _ => detail.to_string(),
    }
}

fn read_u32(cursor: &mut Cursor<&[u8]>) -> Result<u32, String> {
    let bytes = read_exact(cursor, 4)?;
    let mut array = [0u8; 4];
    array.copy_from_slice(bytes);
    Ok(u32::from_be_bytes(array))
}

fn read_u64(cursor: &mut Cursor<&[u8]>) -> Result<u64, String> {
    let bytes = read_exact(cursor, 8)?;
    let mut array = [0u8; 8];
    array.copy_from_slice(bytes);
    Ok(u64::from_be_bytes(array))
}

fn read_string_bytes(cursor: &mut Cursor<&[u8]>) -> Result<Vec<u8>, String> {
    let len = read_u32(cursor)? as usize;
    let bytes = read_exact(cursor, len)?;
    Ok(bytes.to_vec())
}

fn read_string_lossy(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let bytes = read_string_bytes(cursor)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn read_utf8_string(cursor: &mut Cursor<&[u8]>, max: usize) -> Result<String, String> {
    let length = read_u32(cursor)? as usize;
    if length > max {
        return Err(format!("SFTP string exceeds {max} bytes"));
    }
    std::str::from_utf8(read_exact(cursor, length)?)
        .map(str::to_owned)
        .map_err(|_| "Non-UTF-8 remote file names are not supported".into())
}

fn read_file_handle(cursor: &mut Cursor<&[u8]>) -> Result<Vec<u8>, String> {
    let length = read_u32(cursor)? as usize;
    if length > 256 {
        return Err("SFTP file handle exceeds 256 bytes".into());
    }
    Ok(read_exact(cursor, length)?.to_vec())
}

fn read_exact<'a>(cursor: &mut Cursor<&'a [u8]>, len: usize) -> Result<&'a [u8], String> {
    let start = cursor.position() as usize;
    let end = start
        .checked_add(len)
        .ok_or_else(|| "SFTP payload offset overflow".to_string())?;
    let data = *cursor.get_ref();
    if end > data.len() {
        return Err("SFTP payload ended unexpectedly".into());
    }
    cursor.set_position(end as u64);
    Ok(&data[start..end])
}

fn push_u32(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn push_u64(buf: &mut Vec<u8>, value: u64) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn push_string(buf: &mut Vec<u8>, value: &[u8]) -> Result<(), String> {
    let len = u32::try_from(value.len()).map_err(|_| "SFTP string is too large".to_string())?;
    push_u32(buf, len);
    buf.extend_from_slice(value);
    Ok(())
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn entry_type_from_permissions(permissions: Option<u32>) -> Option<String> {
    let mode = permissions? & 0o170000;
    Some(
        match mode {
            0o040000 => "directory",
            0o120000 => "symlink",
            0o100000 => "file",
            _ => "other",
        }
        .into(),
    )
}

fn entry_type_from_longname(longname: &str) -> Option<String> {
    Some(
        match longname.chars().next()? {
            'd' => "directory",
            'l' => "symlink",
            '-' => "file",
            _ => "other",
        }
        .into(),
    )
}

fn format_permissions(mode: u32) -> String {
    let kind = match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        0o100000 => '-',
        _ => '?',
    };
    let mut out = String::with_capacity(10);
    out.push(kind);
    for shift in [6, 3, 0] {
        let bits = (mode >> shift) & 0b111;
        out.push(if bits & 0b100 != 0 { 'r' } else { '-' });
        out.push(if bits & 0b010 != 0 { 'w' } else { '-' });
        out.push(if bits & 0b001 != 0 { 'x' } else { '-' });
    }
    out
}

fn user_facing_subsystem_rejection(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("unknown") || lower.contains("unsupported") || lower.contains("failure") {
        return "Remote SSH server rejected the SFTP subsystem".into();
    }
    if raw.trim().is_empty() {
        "Remote SSH server does not expose the SFTP subsystem".into()
    } else {
        format!("SFTP subsystem is not available ({})", raw.trim())
    }
}

async fn authenticate(
    handle: &mut client::Handle<SftpProbeHandler>,
    username: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
) -> bool {
    use russh::client::AuthResult;

    if let Some(key_data) = private_key {
        match try_key_auth(handle, username, key_data, passphrase).await {
            Ok(true) => return true,
            Ok(false) => info!("[SFTP Auth] key auth rejected for {username}, trying password"),
            Err(error) => warn!("[SFTP Auth] key auth error for {username}: {error}"),
        }
    }

    if let Some(password) = password {
        match handle.authenticate_password(username, password).await {
            Ok(AuthResult::Success) => return true,
            Ok(_) => {}
            Err(error) => warn!("[SFTP Auth] password auth error: {error}"),
        }
    }

    matches!(
        handle.authenticate_password(username, "").await,
        Ok(AuthResult::Success)
    )
}

async fn try_key_auth(
    handle: &mut client::Handle<SftpProbeHandler>,
    username: &str,
    key_data: &str,
    passphrase: Option<&str>,
) -> Result<bool, String> {
    use russh::client::AuthResult;
    use russh::keys::PrivateKeyWithHashAlg;

    let key_pair = russh::keys::decode_secret_key(key_data, passphrase)
        .map_err(|error| format!("decode key: {error}"))?;
    let hash = if matches!(
        key_pair.algorithm(),
        russh::keys::ssh_key::Algorithm::Rsa { .. }
    ) {
        handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| format!("RSA negotiation: {e}"))?
            .flatten()
    } else {
        None
    };
    let key = PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash);
    let auth_result = handle
        .authenticate_publickey(username, key)
        .await
        .map_err(|error| format!("key auth: {error}"))?;

    Ok(matches!(auth_result, AuthResult::Success))
}

#[derive(Clone)]
struct SftpProbeHandler {
    known_hosts: KnownHostsStore,
    hostname: String,
    port: u16,
    key_result: Arc<Mutex<Option<HostKeyResult>>>,
}

impl SftpProbeHandler {
    fn new(known_hosts: KnownHostsStore, hostname: String, port: u16) -> Self {
        Self {
            known_hosts,
            hostname,
            port,
            key_result: Arc::new(Mutex::new(None)),
        }
    }
}

impl client::Handler for SftpProbeHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey {
            key: server_public_key,
            ..
        } = server_public_key
        else {
            return Ok(false);
        };
        let policy = &crate::config::SETTINGS.ssh_known_hosts_policy;
        if policy.eq_ignore_ascii_case("insecure") {
            return Ok(true);
        }

        let algorithm = server_public_key.algorithm();
        let key_type = algorithm.as_str();
        let key_bytes = server_public_key.public_key_bytes();

        let result = self
            .known_hosts
            .check(&self.hostname, self.port, key_type, &key_bytes)
            .await;

        let accept = match &result {
            HostKeyResult::TrustedNew => {
                info!(
                    "[SFTP] TOFU: accepted new {} key for {}:{}",
                    key_type, self.hostname, self.port
                );
                true
            }
            HostKeyResult::TrustedKnown => {
                debug!(
                    "[SFTP] host key verified for {}:{}",
                    self.hostname, self.port
                );
                true
            }
            HostKeyResult::Mismatch { expected, got } => {
                warn!(
                    "[SFTP] host key mismatch for {}:{} expected {}, got {}",
                    self.hostname, self.port, expected, got
                );
                false
            }
            HostKeyResult::StorageError { message } => {
                warn!(
                    "[SFTP] host-key trust storage failed for {}:{}: {}",
                    self.hostname, self.port, message
                );
                false
            }
        };

        *self.key_result.lock().await = Some(result);
        Ok(accept)
    }
}

fn filename_from_remote_path(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("download")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    struct ScriptedStream {
        reads: Cursor<Vec<u8>>,
        writes: Vec<u8>,
    }

    impl ScriptedStream {
        fn new(reads: Vec<u8>) -> Self {
            Self {
                reads: Cursor::new(reads),
                writes: Vec::new(),
            }
        }
    }

    impl AsyncRead for ScriptedStream {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let position = self.reads.position() as usize;
            let available = self.reads.get_ref();
            if position >= available.len() {
                return Poll::Ready(Ok(()));
            }

            let len = (available.len() - position).min(buf.remaining());
            buf.put_slice(&available[position..position + len]);
            self.reads.set_position((position + len) as u64);
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for ScriptedStream {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            data: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.writes.extend_from_slice(data);
            Poll::Ready(Ok(data.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[derive(Debug)]
    struct CapturedPacket {
        packet_type: u8,
        payload: Vec<u8>,
    }

    fn packet(packet_type: u8, payload: Vec<u8>) -> Vec<u8> {
        let mut out = Vec::new();
        push_u32(&mut out, (1 + payload.len()) as u32);
        out.push(packet_type);
        out.extend(payload);
        out
    }

    fn response_packet(packet_type: u8, request_id: u32, mut payload: Vec<u8>) -> Vec<u8> {
        let mut body = Vec::new();
        push_u32(&mut body, request_id);
        body.append(&mut payload);
        packet(packet_type, body)
    }

    fn data_response(request_id: u32, data: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        push_string(&mut payload, data).unwrap();
        response_packet(SSH_FXP_DATA, request_id, payload)
    }

    fn handle_response(request_id: u32, handle: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        push_string(&mut payload, handle).unwrap();
        response_packet(SSH_FXP_HANDLE, request_id, payload)
    }

    fn status_response(request_id: u32, code: u32, message: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        push_u32(&mut payload, code);
        push_string(&mut payload, message.as_bytes()).unwrap();
        response_packet(SSH_FXP_STATUS, request_id, payload)
    }

    fn push_name_entry(
        payload: &mut Vec<u8>,
        name: &str,
        longname: &str,
        size: Option<u64>,
        permissions: Option<u32>,
        modified_time: Option<u32>,
    ) {
        push_string(payload, name.as_bytes()).unwrap();
        push_string(payload, longname.as_bytes()).unwrap();
        let mut flags = 0;
        if size.is_some() {
            flags |= SSH_FILEXFER_ATTR_SIZE;
        }
        if permissions.is_some() {
            flags |= SSH_FILEXFER_ATTR_PERMISSIONS;
        }
        if modified_time.is_some() {
            flags |= SSH_FILEXFER_ATTR_ACMODTIME;
        }
        push_u32(payload, flags);
        if let Some(size) = size {
            push_u64(payload, size);
        }
        if let Some(permissions) = permissions {
            push_u32(payload, permissions);
        }
        if let Some(modified_time) = modified_time {
            push_u32(payload, 0);
            push_u32(payload, modified_time);
        }
    }

    fn captured_packets(bytes: &[u8]) -> Vec<CapturedPacket> {
        let mut packets = Vec::new();
        let mut offset = 0;
        while offset < bytes.len() {
            let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            let packet_start = offset + 4;
            let packet_end = packet_start + length;
            packets.push(CapturedPacket {
                packet_type: bytes[packet_start],
                payload: bytes[packet_start + 1..packet_end].to_vec(),
            });
            offset = packet_end;
        }
        packets
    }

    #[test]
    fn parse_name_entries_accepts_large_batches_under_limit() {
        let mut payload = Vec::new();
        push_u32(&mut payload, 512);
        for index in 0..512 {
            push_name_entry(
                &mut payload,
                &format!("file-{index:03}.log"),
                "-rw-r--r-- 1 user group 42 Jan 1 00:00 file.log",
                Some(42),
                Some(0o100644),
                None,
            );
        }

        let entries = parse_name_entries(&payload, "/var/log").unwrap();
        assert_eq!(entries.len(), 512);
        assert_eq!(entries[0].path, "/var/log/file-000.log");
        assert_eq!(entries[511].entry_type, "file");
        assert_eq!(entries[511].permissions.as_deref(), Some("-rw-r--r--"));
    }

    #[test]
    fn parse_name_entries_rejects_unbounded_directory_batches() {
        let mut payload = Vec::new();
        push_u32(&mut payload, 10_001);

        let error = parse_name_entries(&payload, "/").unwrap_err();
        assert!(error.contains("remote returned too many directory entries"));
    }

    #[test]
    fn parse_name_entries_filters_dot_entries_and_formats_metadata() {
        let mut payload = Vec::new();
        push_u32(&mut payload, 4);
        push_name_entry(&mut payload, ".", "drwxr-xr-x", None, Some(0o040755), None);
        push_name_entry(&mut payload, "..", "drwxr-xr-x", None, Some(0o040755), None);
        push_name_entry(
            &mut payload,
            "config",
            "drwxr-x---",
            None,
            Some(0o040750),
            Some(1_700_000_000),
        );
        push_name_entry(
            &mut payload,
            "current",
            "lrwxrwxrwx",
            Some(12),
            Some(0o120777),
            None,
        );

        let entries = parse_name_entries(&payload, "/etc").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "config");
        assert_eq!(entries[0].path, "/etc/config");
        assert_eq!(entries[0].entry_type, "directory");
        assert_eq!(entries[0].permissions.as_deref(), Some("drwxr-x---"));
        assert!(entries[0].modified_at.is_some());
        assert_eq!(entries[1].entry_type, "symlink");
    }

    #[tokio::test]
    async fn read_all_rejects_downloads_over_limit_without_truncate() {
        let mut stream = ScriptedStream::new(data_response(1, b"hello"));
        let mut client = SftpV3Client::new(&mut stream);

        let error = client.read_all(b"h", 4, false).await.unwrap_err();
        assert!(error.contains("Remote file is larger than the configured 4 byte read limit"));

        let packets = captured_packets(&stream.writes);
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].packet_type, SSH_FXP_READ);
    }

    #[tokio::test]
    async fn read_all_truncates_preview_when_allowed() {
        let mut stream = ScriptedStream::new(data_response(1, b"hello"));
        let mut client = SftpV3Client::new(&mut stream);

        let (data, truncated) = client.read_all(b"h", 4, true).await.unwrap();
        assert_eq!(data, b"hell");
        assert!(truncated);
    }

    #[tokio::test]
    async fn read_packet_rejects_oversized_packets() {
        let mut oversized = Vec::new();
        push_u32(&mut oversized, MAX_SFTP_PACKET_SIZE + 1);

        let mut stream = ScriptedStream::new(oversized);
        let mut client = SftpV3Client::new(&mut stream);
        let error = match client.read_packet().await {
            Ok(_) => panic!("oversized packet should be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("invalid SFTP packet length"));
    }

    #[test]
    fn user_facing_subsystem_rejection_is_stable() {
        assert_eq!(
            user_facing_subsystem_rejection("unknown subsystem"),
            "Remote SSH server rejected the SFTP subsystem"
        );
        assert_eq!(
            user_facing_subsystem_rejection(""),
            "Remote SSH server does not expose the SFTP subsystem"
        );
        assert_eq!(
            user_facing_subsystem_rejection("channel closed"),
            "SFTP subsystem is not available (channel closed)"
        );
    }

    fn attrs_response(id: u32, size: u64, mode: u32) -> Vec<u8> {
        let mut payload = Vec::new();
        push_u32(
            &mut payload,
            SSH_FILEXFER_ATTR_SIZE | SSH_FILEXFER_ATTR_PERMISSIONS,
        );
        push_u64(&mut payload, size);
        push_u32(&mut payload, mode);
        response_packet(105, id, payload)
    }

    fn timed_file_attrs(id: u32, size: u64, mtime: u32) -> Vec<u8> {
        let mut payload = Vec::new();
        push_u32(
            &mut payload,
            SSH_FILEXFER_ATTR_SIZE | SSH_FILEXFER_ATTR_PERMISSIONS | SSH_FILEXFER_ATTR_ACMODTIME,
        );
        push_u64(&mut payload, size);
        push_u32(&mut payload, 0o100644);
        push_u32(&mut payload, mtime);
        push_u32(&mut payload, mtime);
        response_packet(105, id, payload)
    }

    fn transfer(kind: &str, size: Option<u64>, overwrite: bool) -> Transfer {
        let registry = crate::ssh::sftp_transfers::TransferRegistry::default();
        let job = registry
            .create(1, kind, "/file".into(), size, overwrite)
            .unwrap();
        registry.claim(&job.info().id, 1, kind, "/file").unwrap()
    }

    #[tokio::test]
    async fn atomic_upload_uses_exclusive_temporary_and_checks_close_before_rename() {
        let reads = [
            status_response(1, SSH_FX_NO_SUCH_FILE, "missing"),
            handle_response(2, b"h"),
            status_response(3, SSH_FX_OK, ""),
            attrs_response(4, 3, 0o100600),
            status_response(5, SSH_FX_OK, ""),
            status_response(6, SSH_FX_OK, ""),
        ]
        .concat();
        let mut stream = ScriptedStream::new(reads);
        let mut client = SftpV3Client::new(&mut stream);
        let job = transfer("upload", Some(3), false);
        let mut created = TemporaryState::Unused;
        let result = client
            .upload_atomic("/file", "/.temporary", &b"abc"[..], &job, 100, &mut created)
            .await
            .unwrap();
        assert_eq!(result.size, 3);
        assert!(created == TemporaryState::Owned);
        assert_eq!(job.info().bytes_done, 3);
        let packets = captured_packets(&stream.writes);
        assert_eq!(
            packets.iter().map(|p| p.packet_type).collect::<Vec<_>>(),
            [7, 3, 6, 8, 4, 18]
        );
        let mut open = Cursor::new(packets[1].payload.as_slice());
        read_u32(&mut open).unwrap();
        assert_eq!(read_string_bytes(&mut open).unwrap(), b"/.temporary");
        assert_eq!(
            read_u32(&mut open).unwrap(),
            SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_EXCL
        );
    }

    #[tokio::test]
    async fn close_failure_never_commits_upload() {
        let mut stream = ScriptedStream::new(
            [
                status_response(1, SSH_FX_NO_SUCH_FILE, "missing"),
                handle_response(2, b"h"),
                status_response(3, SSH_FX_OK, ""),
                attrs_response(4, 3, 0o100600),
                status_response(5, 4, "disk full"),
            ]
            .concat(),
        );
        let mut client = SftpV3Client::new(&mut stream);
        let mut created = TemporaryState::Unused;
        let error = client
            .upload_atomic(
                "/file",
                "/.tmp",
                &b"abc"[..],
                &transfer("upload", Some(3), false),
                100,
                &mut created,
            )
            .await
            .unwrap_err();
        assert!(error.contains("disk full"));
        assert!(!captured_packets(&stream.writes)
            .iter()
            .any(|p| matches!(p.packet_type, 18 | 200)));
    }

    #[tokio::test]
    async fn existing_file_requires_confirmation_and_atomic_extension() {
        for (overwrite, posix, mode) in [
            (false, true, 0o100644),
            (true, false, 0o100644),
            (true, true, 0o120777),
        ] {
            let mut stream = ScriptedStream::new(attrs_response(1, 10, mode));
            let mut client = SftpV3Client::new(&mut stream);
            client.posix_rename = posix;
            let mut created = TemporaryState::Unused;
            assert!(client
                .upload_atomic(
                    "/file",
                    "/.tmp",
                    &b"abc"[..],
                    &transfer("upload", Some(3), overwrite),
                    100,
                    &mut created
                )
                .await
                .is_err());
            assert!(created == TemporaryState::Unused);
            assert_eq!(captured_packets(&stream.writes).len(), 1);
        }
    }

    #[tokio::test]
    async fn replacement_preserves_permissions_syncs_closes_and_uses_posix_rename() {
        let mut stream = ScriptedStream::new(
            [
                attrs_response(1, 20, 0o100640),
                handle_response(2, b"h"),
                status_response(3, SSH_FX_OK, ""),
                attrs_response(4, 3, 0o100600),
                status_response(5, SSH_FX_OK, ""),
                status_response(6, SSH_FX_OK, ""),
                status_response(7, SSH_FX_OK, ""),
                status_response(8, SSH_FX_OK, ""),
            ]
            .concat(),
        );
        let mut client = SftpV3Client::new(&mut stream);
        client.posix_rename = true;
        client.fsync = true;
        client
            .upload_atomic(
                "/file",
                "/.tmp",
                &b"abc"[..],
                &transfer("upload", Some(3), true),
                100,
                &mut TemporaryState::Unused,
            )
            .await
            .unwrap();
        let packets = captured_packets(&stream.writes);
        assert_eq!(
            packets.iter().map(|p| p.packet_type).collect::<Vec<_>>(),
            [7, 3, 6, 8, 10, 200, 4, 200]
        );
        let mut rename = Cursor::new(packets[7].payload.as_slice());
        read_u32(&mut rename).unwrap();
        assert_eq!(
            read_string_bytes(&mut rename).unwrap(),
            b"posix-rename@openssh.com"
        );
        assert_eq!(read_string_bytes(&mut rename).unwrap(), b"/.tmp");
        assert_eq!(read_string_bytes(&mut rename).unwrap(), b"/file");
    }

    #[tokio::test]
    async fn pipelined_upload_accepts_out_of_order_acknowledgements() {
        let data = vec![42u8; SFTP_WRITE_CHUNK_SIZE * 8];
        let mut reads = [
            status_response(1, SSH_FX_NO_SUCH_FILE, "missing"),
            handle_response(2, b"h"),
        ]
        .concat();
        for id in (3..=10).rev() {
            reads.extend(status_response(id, SSH_FX_OK, ""));
        }
        reads.extend(attrs_response(11, data.len() as u64, 0o100600));
        reads.extend(status_response(12, SSH_FX_OK, ""));
        reads.extend(status_response(13, SSH_FX_OK, ""));
        let mut stream = ScriptedStream::new(reads);
        let mut client = SftpV3Client::new(&mut stream);
        let job = transfer("upload", Some(data.len() as u64), false);
        client
            .upload_atomic(
                "/file",
                "/.tmp",
                data.as_slice(),
                &job,
                data.len(),
                &mut TemporaryState::Unused,
            )
            .await
            .unwrap();
        assert_eq!(job.info().bytes_done, data.len() as u64);
        assert_eq!(
            captured_packets(&stream.writes)
                .iter()
                .filter(|p| p.packet_type == SSH_FXP_WRITE)
                .count(),
            8
        );
    }

    #[tokio::test]
    async fn failed_write_and_short_source_never_rename() {
        for (size, code) in [(3, SSH_FX_PERMISSION_DENIED), (4, SSH_FX_OK)] {
            let mut stream = ScriptedStream::new(
                [
                    status_response(1, SSH_FX_NO_SUCH_FILE, "missing"),
                    handle_response(2, b"h"),
                    status_response(3, code, "write failure"),
                ]
                .concat(),
            );
            let mut client = SftpV3Client::new(&mut stream);
            assert!(client
                .upload_atomic(
                    "/file",
                    "/.tmp",
                    &b"abc"[..],
                    &transfer("upload", Some(size), false),
                    100,
                    &mut TemporaryState::Unused
                )
                .await
                .is_err());
            assert!(!captured_packets(&stream.writes)
                .iter()
                .any(|p| p.packet_type == 18));
        }
    }

    #[tokio::test]
    async fn cancellation_prevents_any_write_or_commit() {
        let mut stream = ScriptedStream::new(Vec::new());
        let mut client = SftpV3Client::new(&mut stream);
        let job = transfer("upload", Some(3), false);
        job.request_cancel().unwrap();
        let error = client
            .upload_atomic(
                "/file",
                "/.tmp",
                &b"abc"[..],
                &job,
                100,
                &mut TemporaryState::Unused,
            )
            .await
            .unwrap_err();
        assert!(error.contains("cancelled"));
        assert!(stream.writes.is_empty());
    }

    #[tokio::test]
    async fn pipelined_download_orders_responses_and_fills_short_reads() {
        let data = vec![17u8; SFTP_READ_CHUNK_SIZE as usize];
        let mut name = Vec::new();
        push_u32(&mut name, 1);
        push_name_entry(&mut name, "/file", "", None, None, None);
        let reads = [
            response_packet(SSH_FXP_NAME, 1, name),
            handle_response(2, b"h"),
            attrs_response(3, data.len() as u64 + 4, 0o100644),
            data_response(5, b"tail"),
            data_response(4, &data[..100]),
            data_response(6, &data[100..]),
            attrs_response(7, data.len() as u64 + 4, 0o100644),
            status_response(8, SSH_FX_OK, ""),
        ]
        .concat();
        let mut stream = ScriptedStream::new(reads);
        let mut client = SftpV3Client::new(&mut stream);
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let job = transfer("download", None, false);
        client
            .download_to("/file", 100_000, &job, &tx)
            .await
            .unwrap();
        drop(tx);
        let mut result = Vec::new();
        while let Some(chunk) = rx.recv().await {
            result.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(result, [data, b"tail".to_vec()].concat());
        assert_eq!(job.info().bytes_done, result.len() as u64);
    }

    #[tokio::test]
    async fn extension_negotiation_checks_exact_version() {
        let mut hello = Vec::new();
        push_u32(&mut hello, 3);
        push_string(&mut hello, b"posix-rename@openssh.com").unwrap();
        push_string(&mut hello, b"2").unwrap();
        push_string(&mut hello, b"fsync@openssh.com").unwrap();
        push_string(&mut hello, b"1").unwrap();
        let mut stream = ScriptedStream::new(packet(SSH_FXP_VERSION, hello));
        let mut client = SftpV3Client::new(&mut stream);
        client.init().await.unwrap();
        assert!(!client.posix_rename);
        assert!(client.fsync);
    }

    #[test]
    fn directory_entries_cannot_smuggle_paths_or_expand_metadata_unboundedly() {
        for name in ["../outside", "a/b", "x\0y", ""] {
            let mut payload = Vec::new();
            push_u32(&mut payload, 1);
            push_name_entry(&mut payload, name, "", None, None, None);
            assert!(parse_name_entries(&payload, "/safe").is_err());
        }
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        push_name_entry(&mut payload, "file", "", None, None, None);
        assert!(parse_name_entries(&payload, &"a".repeat(4096)).is_err());
    }

    #[tokio::test]
    async fn growing_download_is_bounded_to_initial_size_and_reports_growth() {
        for final_size in [4, 1000] {
            let mut name = Vec::new();
            push_u32(&mut name, 1);
            push_name_entry(&mut name, "/file", "", None, None, None);
            let mut stream = ScriptedStream::new(
                [
                    response_packet(SSH_FXP_NAME, 1, name),
                    handle_response(2, b"h"),
                    timed_file_attrs(3, 3, 10),
                    data_response(4, b"abc"),
                    timed_file_attrs(5, final_size, 11),
                    status_response(6, SSH_FX_OK, ""),
                ]
                .concat(),
            );
            let (tx, mut rx) = tokio::sync::mpsc::channel(4);
            let job = transfer("download", None, false);
            SftpV3Client::new(&mut stream)
                .download_to("/file", 100, &job, &tx)
                .await
                .unwrap();
            drop(tx);
            assert_eq!(rx.recv().await.unwrap().unwrap(), &b"abc"[..]);
            assert!(rx.recv().await.is_none());
            assert_eq!(job.info().bytes_total, Some(3));
            assert_eq!(job.info().bytes_done, 3);
            assert!(job
                .info()
                .warning
                .unwrap()
                .contains("Saved the first 3 bytes"));
            assert_eq!(
                captured_packets(&stream.writes)
                    .iter()
                    .filter(|packet| packet.packet_type == SSH_FXP_READ)
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn truncated_or_same_size_modified_download_is_not_successful() {
        for final_size in [2, 3] {
            let mut name = Vec::new();
            push_u32(&mut name, 1);
            push_name_entry(&mut name, "/file", "", None, None, None);
            let mut stream = ScriptedStream::new(
                [
                    response_packet(SSH_FXP_NAME, 1, name),
                    handle_response(2, b"h"),
                    timed_file_attrs(3, 3, 10),
                    data_response(4, b"abc"),
                    timed_file_attrs(5, final_size, 11),
                    status_response(6, SSH_FX_OK, ""),
                ]
                .concat(),
            );
            let mut client = SftpV3Client::new(&mut stream);
            let (tx, _rx) = tokio::sync::mpsc::channel(4);
            let error = client
                .download_to("/file", 100, &transfer("download", None, false), &tx)
                .await
                .unwrap_err();
            assert!(error.contains("changed during download"));
        }
    }

    #[tokio::test]
    async fn download_does_not_accept_early_eof_failed_close_or_oversized_initial_file() {
        for failure in ["early-eof", "close", "oversize"] {
            let mut name = Vec::new();
            push_u32(&mut name, 1);
            push_name_entry(&mut name, "/file", "", None, None, None);
            let mut replies = [
                response_packet(SSH_FXP_NAME, 1, name),
                handle_response(2, b"h"),
                attrs_response(3, if failure == "oversize" { 101 } else { 3 }, 0o100644),
            ]
            .concat();
            if failure == "early-eof" {
                replies.extend(status_response(4, SSH_FX_EOF, "truncated"));
            } else if failure == "close" {
                replies.extend(data_response(4, b"abc"));
                replies.extend(attrs_response(5, 3, 0o100644));
                replies.extend(status_response(6, SSH_FX_PERMISSION_DENIED, "close failed"));
            }
            let mut stream = ScriptedStream::new(replies);
            let (tx, _rx) = tokio::sync::mpsc::channel(4);
            let job = transfer("download", None, false);
            assert!(SftpV3Client::new(&mut stream)
                .download_to("/file", 100, &job, &tx)
                .await
                .is_err());
            assert!(job.info().warning.is_none());
            if failure == "oversize" {
                assert!(!captured_packets(&stream.writes)
                    .iter()
                    .any(|packet| packet.packet_type == SSH_FXP_READ));
            }
        }
    }

    #[tokio::test]
    async fn cancellation_before_open_ack_does_not_claim_ownership_of_temporary() {
        let (mut stream, mut server) = tokio::io::duplex(1024);
        let job = transfer("upload", Some(3), false);
        let cancel = job.clone();
        let remote = tokio::spawn(async move {
            let length = server.read_u32().await.unwrap();
            let mut request = vec![0u8; length as usize];
            server.read_exact(&mut request).await.unwrap();
            assert_eq!(request[0], 7);
            server
                .write_all(&status_response(1, SSH_FX_NO_SUCH_FILE, "missing"))
                .await
                .unwrap();
            let length = server.read_u32().await.unwrap();
            let mut request = vec![0u8; length as usize];
            server.read_exact(&mut request).await.unwrap();
            assert_eq!(request[0], SSH_FXP_OPEN);
            cancel.request_cancel().unwrap();
        });
        let mut client = SftpV3Client::new(&mut stream);
        let mut state = TemporaryState::Unused;
        assert!(client
            .upload_atomic("/file", "/.tmp", &b"abc"[..], &job, 100, &mut state)
            .await
            .is_err());
        remote.await.unwrap();
        assert!(state == TemporaryState::Unconfirmed);
    }
}
