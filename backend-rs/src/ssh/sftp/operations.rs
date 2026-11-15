//! SFTP v3 file operations. Uploads never truncate the destination in place.
use super::*;
use std::collections::{BTreeMap, HashMap};
use tokio::sync::mpsc;
use tokio::time::timeout;

const SSH_FXP_LSTAT: u8 = 7;
const SSH_FXP_FSTAT: u8 = 8;
const SSH_FXP_SETSTAT: u8 = 9;
const SSH_FXP_FSETSTAT: u8 = 10;
const SSH_FXP_REMOVE: u8 = 13;
const SSH_FXP_MKDIR: u8 = 14;
const SSH_FXP_RMDIR: u8 = 15;
const SSH_FXP_RENAME: u8 = 18;
const SSH_FXP_ATTRS: u8 = 105;
const SSH_FXP_EXTENDED: u8 = 200;
const WINDOW: usize = 8;

impl<S: AsyncRead + AsyncWrite + Unpin> SftpV3Client<S> {
    async fn status(&mut self, request: u32) -> Result<(), String> {
        let response = self.read_response(request).await?;
        status_ok(&response)
    }

    async fn path_status(&mut self, kind: u8, path: &str) -> Result<(), String> {
        let id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, id);
        push_string(&mut payload, path.as_bytes())?;
        self.send_packet(kind, &payload).await?;
        self.status(id).await
    }

    async fn attrs(&mut self, kind: u8, path: &[u8]) -> Result<Option<SftpAttrs>, String> {
        let id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, id);
        push_string(&mut payload, path)?;
        self.send_packet(kind, &payload).await?;
        let response = self.read_response(id).await?;
        if response.packet_type == SSH_FXP_STATUS {
            let (code, message) = parse_status(&response.payload)?;
            return if kind == SSH_FXP_LSTAT && code == SSH_FX_NO_SUCH_FILE {
                Ok(None)
            } else {
                Err(status_message(code, &message))
            };
        }
        if response.packet_type != SSH_FXP_ATTRS {
            return Err("Expected SFTP file attributes".into());
        }
        read_attrs(&mut Cursor::new(response.payload.as_slice())).map(Some)
    }

    async fn set_permissions(
        &mut self,
        kind: u8,
        path: &[u8],
        permissions: u32,
    ) -> Result<(), String> {
        let id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, id);
        push_string(&mut payload, path)?;
        push_u32(&mut payload, SSH_FILEXFER_ATTR_PERMISSIONS);
        push_u32(&mut payload, permissions);
        self.send_packet(kind, &payload).await?;
        self.status(id).await
    }

    async fn rename(
        &mut self,
        source: &str,
        destination: &str,
        overwrite: bool,
    ) -> Result<(), String> {
        if overwrite && !self.posix_rename {
            return Err("This server cannot replace files atomically (posix-rename is unavailable). Choose a new name.".into());
        }
        let id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, id);
        if overwrite {
            push_string(&mut payload, b"posix-rename@openssh.com")?;
        }
        push_string(&mut payload, source.as_bytes())?;
        push_string(&mut payload, destination.as_bytes())?;
        self.send_packet(
            if overwrite {
                SSH_FXP_EXTENDED
            } else {
                SSH_FXP_RENAME
            },
            &payload,
        )
        .await?;
        self.status(id).await
    }

    async fn sync_file(&mut self, handle: &[u8]) -> Result<(), String> {
        if !self.fsync {
            return Ok(());
        }
        let id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, id);
        push_string(&mut payload, b"fsync@openssh.com")?;
        push_string(&mut payload, handle)?;
        self.send_packet(SSH_FXP_EXTENDED, &payload).await?;
        self.status(id).await
    }

    pub(super) async fn remove_if_exists(&mut self, path: &str) -> Result<(), String> {
        if self.attrs(SSH_FXP_LSTAT, path.as_bytes()).await?.is_some() {
            self.path_status(SSH_FXP_REMOVE, path).await?;
        }
        Ok(())
    }

    pub(super) async fn mutate(
        &mut self,
        action: &str,
        path: &str,
        destination: Option<&str>,
        permissions: Option<u32>,
    ) -> Result<(), String> {
        match action {
            "mkdir" => {
                let id = self.next_request_id();
                let mut payload = Vec::new();
                push_u32(&mut payload, id);
                push_string(&mut payload, path.as_bytes())?;
                push_u32(&mut payload, SSH_FILEXFER_ATTR_PERMISSIONS);
                push_u32(&mut payload, 0o755);
                self.send_packet(SSH_FXP_MKDIR, &payload).await?;
                self.status(id).await
            }
            "rename" => {
                self.rename(path, destination.ok_or("Missing destination")?, false)
                    .await
            }
            "delete" => {
                let attrs = self
                    .attrs(SSH_FXP_LSTAT, path.as_bytes())
                    .await?
                    .ok_or("File no longer exists")?;
                let directory = attrs
                    .permissions
                    .is_some_and(|mode| mode & 0o170000 == 0o040000);
                // RMDIR only removes empty directories. Never recurse or follow symlinks.
                self.path_status(
                    if directory {
                        SSH_FXP_RMDIR
                    } else {
                        SSH_FXP_REMOVE
                    },
                    path,
                )
                .await
            }
            "chmod" => {
                let attrs = self
                    .attrs(SSH_FXP_LSTAT, path.as_bytes())
                    .await?
                    .ok_or("File no longer exists")?;
                if attrs
                    .permissions
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
                {
                    return Err("Changing permissions on symlinks is not supported".into());
                }
                let mode = permissions
                    .filter(|mode| *mode <= 0o777)
                    .ok_or("Permissions must be between 000 and 777")?;
                self.set_permissions(SSH_FXP_SETSTAT, path.as_bytes(), mode)
                    .await
            }
            _ => Err("Unknown SFTP operation".into()),
        }
    }

    async fn open_temporary(&mut self, path: &str) -> Result<Vec<u8>, String> {
        let id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, id);
        push_string(&mut payload, path.as_bytes())?;
        push_u32(&mut payload, SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_EXCL);
        push_u32(&mut payload, SSH_FILEXFER_ATTR_PERMISSIONS);
        push_u32(&mut payload, 0o600);
        self.send_packet(SSH_FXP_OPEN, &payload).await?;
        let response = self.read_response(id).await?;
        if response.packet_type == SSH_FXP_STATUS {
            return Err(status_error(&response.payload)?);
        }
        if response.packet_type != SSH_FXP_HANDLE {
            return Err("Expected temporary file handle".into());
        }
        let handle = read_string_bytes(&mut Cursor::new(response.payload.as_slice()))?;
        if handle.len() > 256 {
            return Err("SFTP file handle exceeds 256 bytes".into());
        }
        Ok(handle)
    }

    pub(super) async fn upload_atomic<R: AsyncRead + Unpin>(
        &mut self,
        path: &str,
        temporary: &str,
        mut input: R,
        job: &Transfer,
        max_bytes: usize,
        created: &mut TemporaryState,
    ) -> Result<SftpUploadResult, String> {
        let info = job.info();
        let prepare = async {
            let existing = self.attrs(SSH_FXP_LSTAT, path.as_bytes()).await?;
            if let Some(attrs) = &existing {
                if !info.overwrite {
                    return Err("A file with this name already exists. Confirm replacement or choose another name.".into());
                }
                if !self.posix_rename {
                    return Err(
                        "This server cannot replace files atomically. Choose another name.".into(),
                    );
                }
                if attrs
                    .permissions
                    .is_none_or(|mode| mode & 0o170000 != 0o100000)
                {
                    return Err("Only regular files can be replaced; symlinks and directories are protected".into());
                }
            }
            *created = TemporaryState::Unconfirmed;
            let handle = self.open_temporary(temporary).await?;
            *created = TemporaryState::Owned;
            let mut offset = 0u64;
            let mut eof = false;
            while !eof {
                let mut pending = HashMap::new();
                for _ in 0..WINDOW {
                    let mut chunk = vec![0u8; SFTP_WRITE_CHUNK_SIZE];
                    let count = timeout(Duration::from_secs(30), input.read(&mut chunk))
                        .await
                        .map_err(|_| "Upload source stalled for 30 seconds".to_string())?
                        .map_err(|error| format!("Cannot read upload source: {error}"))?;
                    if count == 0 {
                        eof = true;
                        break;
                    }
                    if offset + count as u64 > max_bytes as u64 {
                        return Err(format!("Upload exceeds the {max_bytes} byte limit"));
                    }
                    if info
                        .bytes_total
                        .is_some_and(|total| offset + count as u64 > total)
                    {
                        return Err("Upload is larger than its declared size".into());
                    }
                    let id = self.next_request_id();
                    let mut payload = Vec::new();
                    push_u32(&mut payload, id);
                    push_string(&mut payload, &handle)?;
                    push_u64(&mut payload, offset);
                    push_string(&mut payload, &chunk[..count])?;
                    self.send_packet(SSH_FXP_WRITE, &payload).await?;
                    pending.insert(id, count as u64);
                    offset += count as u64;
                }
                while !pending.is_empty() {
                    let (id, packet) = self.response_with_id().await?;
                    let count = pending
                        .remove(&id)
                        .ok_or("Unexpected SFTP write acknowledgement")?;
                    status_ok(&packet)?;
                    job.progress(count);
                }
            }
            if info.bytes_total.is_some_and(|total| offset != total) {
                return Err("Upload ended before its declared size".into());
            }
            job.total(Some(offset));
            job.state("finalizing");
            let attrs = self
                .attrs(SSH_FXP_FSTAT, &handle)
                .await?
                .ok_or("Missing uploaded file attributes")?;
            if attrs.size.is_some_and(|size| size != offset) {
                return Err("Uploaded file size does not match acknowledged bytes".into());
            }
            if let Some(mode) = existing.as_ref().and_then(|attrs| attrs.permissions) {
                self.set_permissions(SSH_FXP_FSETSTAT, &handle, mode & 0o777)
                    .await?;
            }
            self.sync_file(&handle).await?;
            self.close(&handle).await?;
            Ok((offset, existing.is_some()))
        };
        let (size, replacing) = tokio::select! {
            biased;
            _ = job.cancel.cancelled() => return Err("Transfer cancelled".into()),
            result = timeout(Duration::from_secs(15 * 60), prepare) => result.map_err(|_| "Upload exceeded the 15 minute transfer limit".to_string())??,
        };
        job.begin_commit()?;
        // Once committing, only the bounded server reply decides success. Never
        // auto-retry a write when the rename acknowledgement might have been lost.
        self.rename(temporary, path, replacing).await.map_err(|error| format!("Could not confirm file commit: {error}. Refresh the directory before retrying."))?;
        Ok(SftpUploadResult {
            path: path.into(),
            size: size as usize,
        })
    }

    async fn response_with_id(&mut self) -> Result<(u32, SftpPacket), String> {
        let mut packet = self.read_packet().await?;
        let id = read_u32(&mut Cursor::new(packet.payload.as_slice()))?;
        packet.payload.drain(..4);
        Ok((id, packet))
    }

    async fn request_read(
        &mut self,
        handle: &[u8],
        offset: u64,
        length: u32,
    ) -> Result<u32, String> {
        let id = self.next_request_id();
        let mut payload = Vec::new();
        push_u32(&mut payload, id);
        push_string(&mut payload, handle)?;
        push_u64(&mut payload, offset);
        push_u32(&mut payload, length);
        self.send_packet(SSH_FXP_READ, &payload).await?;
        Ok(id)
    }

    pub(super) async fn download_to(
        &mut self,
        path: &str,
        max_bytes: usize,
        job: &Transfer,
        output: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    ) -> Result<(), String> {
        let canonical = self.realpath(path).await?;
        let handle = self.open_file(&canonical).await?;
        let before = self
            .attrs(SSH_FXP_FSTAT, &handle)
            .await?
            .ok_or("Missing remote file attributes")?;
        if before
            .permissions
            .is_some_and(|mode| mode & 0o170000 != 0o100000)
        {
            return Err("Only regular files can be downloaded".into());
        }
        if before.size.is_some_and(|size| size > max_bytes as u64) {
            return Err(format!("Download exceeds the {max_bytes} byte limit"));
        }
        job.total(before.size);
        let mut offset = 0u64;
        if let Some(size) = before.size {
            while offset < size {
                let mut pending = HashMap::new();
                for _ in 0..WINDOW {
                    if offset >= size {
                        break;
                    }
                    let len = (size - offset).min(SFTP_READ_CHUNK_SIZE as u64) as u32;
                    let id = self.request_read(&handle, offset, len).await?;
                    pending.insert(id, (offset, len));
                    offset += len as u64;
                }
                let mut ready = BTreeMap::new();
                while !pending.is_empty() {
                    let (id, packet) = self.response_with_id().await?;
                    let (at, wanted) =
                        pending.remove(&id).ok_or("Unexpected SFTP read response")?;
                    if packet.packet_type == SSH_FXP_STATUS {
                        return Err(format!(
                            "File changed or read failed: {}",
                            status_error(&packet.payload)?
                        ));
                    }
                    if packet.packet_type != SSH_FXP_DATA {
                        return Err("Expected SFTP data".into());
                    }
                    let data = read_string_bytes(&mut Cursor::new(packet.payload.as_slice()))?;
                    if data.is_empty() || data.len() > wanted as usize {
                        return Err("Invalid SFTP read length".into());
                    }
                    if data.len() < wanted as usize {
                        let next = self
                            .request_read(
                                &handle,
                                at + data.len() as u64,
                                wanted - data.len() as u32,
                            )
                            .await?;
                        pending.insert(next, (at + data.len() as u64, wanted - data.len() as u32));
                    }
                    ready.insert(at, data);
                }
                for data in ready.into_values() {
                    send_download(output, job, data).await?;
                }
            }
        } else {
            loop {
                let Some(data) = self
                    .read_chunk(&handle, offset, SFTP_READ_CHUNK_SIZE)
                    .await?
                else {
                    break;
                };
                if data.is_empty() {
                    return Err("Empty SFTP data without EOF".into());
                }
                offset += data.len() as u64;
                if offset > max_bytes as u64 {
                    return Err(format!("Download exceeds the {max_bytes} byte limit"));
                }
                send_download(output, job, data).await?;
            }
        }
        let after = self
            .attrs(SSH_FXP_FSTAT, &handle)
            .await?
            .ok_or("Missing remote file attributes")?;
        self.close(&handle).await?;
        // READs are bounded by the size observed on the opened handle. A log may
        // grow while those bytes are transferred; do not chase its moving EOF.
        // SFTP v3 cannot guarantee a consistent snapshot of concurrently rewritten
        // bytes, so report growth explicitly and retain strict checks otherwise.
        let grew = matches!((before.size, after.size), (Some(start), Some(end)) if end > start);
        if grew {
            job.warn(format!(
                "Remote file grew during download. Saved the first {offset} bytes; later data is not included."
            ));
        } else if before.size != after.size || before.modified_time != after.modified_time {
            return Err("Remote file changed during download; retry with a stable file".into());
        }
        job.total(Some(offset));
        Ok(())
    }
}

fn status_ok(packet: &SftpPacket) -> Result<(), String> {
    if packet.packet_type != SSH_FXP_STATUS {
        return Err("Expected SFTP status".into());
    }
    let (code, message) = parse_status(&packet.payload)?;
    if code == SSH_FX_OK {
        Ok(())
    } else {
        Err(status_message(code, &message))
    }
}

async fn send_download(
    output: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    job: &Transfer,
    data: Vec<u8>,
) -> Result<(), String> {
    let size = data.len() as u64;
    timeout(Duration::from_secs(30), output.send(Ok(Bytes::from(data))))
        .await
        .map_err(|_| "Download destination stalled for 30 seconds".to_string())?
        .map_err(|_| "Download destination closed".to_string())?;
    job.progress(size);
    Ok(())
}
