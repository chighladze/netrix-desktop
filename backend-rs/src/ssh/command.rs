//! Bounded SSH exec output, independent of interactive terminal sessions.
use russh::ChannelMsg;

#[derive(Debug, Default)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub error: Option<String>,
}

impl CommandOutput {
    pub fn receive(&mut self, message: ChannelMsg, limit: usize) -> bool {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, ext: 0 } => {
                self.append(&data, false, limit);
            }
            ChannelMsg::ExtendedData { data, .. } => self.append(&data, true, limit),
            ChannelMsg::ExitStatus { exit_status } => self.exit_status = Some(exit_status),
            ChannelMsg::Failure => {
                self.error = Some("SSH server rejected command execution".into());
                return false;
            }
            ChannelMsg::ExitSignal { .. } => {
                self.error = Some("Remote command was terminated by a signal".into());
                return false;
            }
            ChannelMsg::Close => return false,
            _ => {}
        }
        !self.truncated
    }

    fn append(&mut self, data: &[u8], stderr: bool, limit: usize) {
        let remaining = limit.saturating_sub(self.stdout.len() + self.stderr.len());
        let copied = remaining.min(data.len());
        let target = if stderr {
            &mut self.stderr
        } else {
            &mut self.stdout
        };
        target.extend_from_slice(&data[..copied]);
        self.truncated |= copied < data.len();
    }

    pub fn finish(&mut self) {
        if self.error.is_some() {
            return;
        }
        self.error = if self.timed_out {
            Some("Remote command timed out".into())
        } else if self.truncated {
            Some("Command output exceeded the configured limit".into())
        } else {
            match self.exit_status {
                Some(0) => None,
                Some(status) => Some(format!("Remote command exited with status {status}")),
                None => Some("SSH session ended without a command exit status".into()),
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exit_status_does_not_discard_trailing_output_and_stderr_is_separate() {
        let mut result = CommandOutput::default();
        assert!(result.receive(ChannelMsg::ExitStatus { exit_status: 7 }, 100));
        assert!(result.receive(
            ChannelMsg::Data {
                data: b"after exit"[..].into()
            },
            100
        ));
        assert!(result.receive(
            ChannelMsg::ExtendedData {
                ext: 1,
                data: b"failure"[..].into()
            },
            100
        ));
        assert!(!result.receive(ChannelMsg::Close, 100));
        result.finish();
        assert_eq!(result.stdout, b"after exit");
        assert_eq!(result.stderr, b"failure");
        assert!(result.error.unwrap().contains('7'));
    }
    #[test]
    fn output_budget_is_shared_and_timeouts_and_missing_status_are_errors() {
        let mut result = CommandOutput::default();
        result.receive(
            ChannelMsg::Data {
                data: b"123"[..].into(),
            },
            5,
        );
        assert!(!result.receive(
            ChannelMsg::ExtendedData {
                ext: 1,
                data: b"456"[..].into()
            },
            5
        ));
        assert_eq!(result.stdout.len() + result.stderr.len(), 5);
        result.finish();
        assert!(result.error.is_some());
        let mut timeout = CommandOutput {
            timed_out: true,
            ..Default::default()
        };
        timeout.finish();
        assert!(timeout.error.unwrap().contains("timed out"));
        let mut missing = CommandOutput::default();
        missing.finish();
        assert!(missing.error.is_some());
    }
}
