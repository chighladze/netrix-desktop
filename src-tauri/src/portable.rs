//! Windows Portable is selected by the marker shipped beside the executable.
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};

pub const PREFIX: &str = "com.netrix.portable.";
pub struct Profile {
    pub data: PathBuf,
    pub identifier: String,
}

impl Profile {
    pub fn beside(exe: &Path) -> io::Result<Option<Self>> {
        let root = exe
            .parent()
            .ok_or_else(|| io::Error::other("Missing executable directory"))?;
        match fs::metadata(root.join("Netrix.portable")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Ok(marker) if marker.is_file() => {}
            Ok(_) => return Err(io::Error::other("Netrix.portable must be a file")),
            Err(error) => return Err(error),
        }
        let data = root.join("Data");
        fs::create_dir_all(&data)?;
        // Detect read-only media before starting either process. Never fall back
        // to the installed workspace when a portable workspace is unwritable.
        let probe = data.join(format!(".write-test-{}", uuid::Uuid::new_v4()));
        drop(fs::File::create_new(&probe)?);
        fs::remove_file(probe)?;
        let mut hash = DefaultHasher::new();
        data.canonicalize()?
            .to_string_lossy()
            .to_lowercase()
            .hash(&mut hash);
        Ok(Some(Self {
            data,
            identifier: format!("{PREFIX}{:016x}", hash.finish()),
        }))
    }
}

#[cfg(windows)]
pub fn startup_error(message: &str) -> ! {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let body: Vec<u16> = message.encode_utf16().chain([0]).collect();
    let title: Vec<u16> = "Netrix Portable".encode_utf16().chain([0]).collect();
    // Both strings are null-terminated and valid through this synchronous call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_marker_enables_portable_and_invalid_data_fails_closed() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let exe = root.join("Netrix.exe");
        assert!(Profile::beside(&exe).unwrap().is_none());
        assert!(!root.join("Data").exists());
        fs::create_dir(root.join("Data")).unwrap();
        assert!(Profile::beside(&exe).unwrap().is_none());
        fs::write(root.join("Netrix.portable"), "").unwrap();
        let profile = Profile::beside(&exe).unwrap().unwrap();
        assert_eq!(profile.data, root.join("Data"));
        assert_eq!(
            profile.identifier,
            Profile::beside(&exe).unwrap().unwrap().identifier
        );
        assert!(profile.identifier.starts_with(PREFIX));
        assert_eq!(profile.data.read_dir().unwrap().count(), 0);
        fs::remove_dir(&profile.data).unwrap();
        fs::write(&profile.data, "occupied").unwrap();
        assert!(Profile::beside(&exe).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
