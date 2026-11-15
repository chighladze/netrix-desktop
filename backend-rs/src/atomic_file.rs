//! Same-volume file publication for encrypted storage and SSH trust.
use std::{
    io,
    path::{Path, PathBuf},
};

pub(crate) fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = native_path(source)?
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let destination: Vec<u16> = native_path(destination)?
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Both owned buffers are NUL-terminated and live until the call returns.
        // Keep replacement atomic: no copy/delete fallback on any failure.
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    std::fs::rename(source, destination)
}

pub(crate) fn native_path(path: &Path) -> io::Result<PathBuf> {
    #[cfg(not(windows))]
    {
        Ok(path.to_path_buf())
    }
    #[cfg(windows)]
    {
        use std::{
            ffi::OsString,
            os::windows::ffi::{OsStrExt, OsStringExt},
            path::{Component, Prefix},
        };
        if path.as_os_str().encode_wide().any(|unit| unit == 0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "File path contains NUL",
            ));
        }
        // Resolve relative paths, separators and dot segments before adding the
        // extended prefix. Unlike canonicalize, absolute permits a new destination.
        let absolute = std::path::absolute(path)?;
        let units: Vec<u16> = absolute.as_os_str().encode_wide().collect();
        let extended: Vec<u16> = match absolute.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(_) => r"\\?\".encode_utf16().chain(units).collect(),
                Prefix::UNC(_, _) => r"\\?\UNC\"
                    .encode_utf16()
                    .chain(units.into_iter().skip(2))
                    .collect(),
                Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _) => units,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Expected a filesystem path",
                    ))
                }
            },
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Expected an absolute file path",
                ))
            }
        };
        Ok(OsString::from_wide(&extended).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_paths_normalize_before_prefixing_without_accessing_a_share() {
        use std::os::windows::ffi::OsStrExt;
        for (input, expected) in [
            (r"C:\profile\new.key", r"\\?\C:\profile\new.key"),
            (r"C:/profile/old/.././new.key", r"\\?\C:\profile\new.key"),
            (
                r"\\server\share\profile\new.key",
                r"\\?\UNC\server\share\profile\new.key",
            ),
            (
                r"\\server\share\old\..\new.key",
                r"\\?\UNC\server\share\new.key",
            ),
            (r"\\?\C:\profile\new.key", r"\\?\C:\profile\new.key"),
            (
                r"\\?\UNC\server\share\new.key",
                r"\\?\UNC\server\share\new.key",
            ),
            (
                r"C:\профиль\ქართული\🔑.key",
                r"\\?\C:\профиль\ქართული\🔑.key",
            ),
        ] {
            assert_eq!(
                native_path(Path::new(input))
                    .unwrap()
                    .as_os_str()
                    .encode_wide()
                    .collect::<Vec<_>>(),
                expected.encode_utf16().collect::<Vec<_>>()
            );
        }
        let relative = native_path(Path::new(r".\missing-parent\..\new.key")).unwrap();
        let absolute = native_path(&std::env::current_dir().unwrap().join("new.key")).unwrap();
        assert_eq!(relative, absolute);
        assert!(native_path(Path::new("")).is_err());
        assert!(native_path(Path::new("C:\\profile\\bad\0suffix")).is_err());
        assert!(native_path(Path::new(r"\\.\PhysicalDrive0")).is_err());
        assert!(native_path(Path::new(r"\\?\GLOBALROOT\Device\HarddiskVolume1")).is_err());
    }

    #[test]
    fn replacement_publishes_complete_bytes_and_failure_retains_both_files() {
        let directory =
            std::env::temp_dir().join(format!("netrix-atomic-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("pending");
        let destination = directory.join("published");
        std::fs::write(&source, b"new complete bytes").unwrap();
        std::fs::write(&destination, b"old complete bytes").unwrap();
        assert!(replace(&source, &directory.join("missing-parent/published")).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"new complete bytes");
        assert_eq!(std::fs::read(&destination).unwrap(), b"old complete bytes");
        replace(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"new complete bytes");
        assert!(!source.exists());
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
