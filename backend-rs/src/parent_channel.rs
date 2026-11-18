//! Private control pipe from the desktop shell. EOF is the shutdown signal.
use std::io::{self, BufRead, Read};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(12);

pub async fn receive_token(stop: CancellationToken) -> io::Result<Option<String>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("netrix-parent-pipe".into())
        .spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut token = String::new();
            let result = stdin
                .by_ref()
                .take(128)
                .read_line(&mut token)
                .and_then(|_| {
                    if token.is_empty() {
                        return Ok(None); // Shell closed before authorizing startup.
                    }
                    if !token.ends_with('\n') || token.trim().is_empty() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Invalid startup frame",
                        ));
                    }
                    token.truncate(token.trim_end().len());
                    Ok(Some(token))
                });
            let started = matches!(result, Ok(Some(_)));
            if sender.send(result).is_err() || !started {
                return;
            }

            // The parent's write handle is non-inheritable. EOF also covers a
            // crashing shell when Windows could not assign us to the Job Object.
            // No bytes after the token are interpreted as commands.
            let _ = io::copy(&mut stdin, &mut io::sink());
            stop.cancel();
            std::thread::sleep(SHUTDOWN_TIMEOUT + Duration::from_secs(2));
            // A blocked native call can prevent an async deadline from firing.
            std::process::exit(1);
        })?;
    receiver.await.map_err(io::Error::other)?
}
