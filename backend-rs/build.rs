fn main() -> std::io::Result<()> {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // ProductVersion defaults to the full Cargo package version, including prereleases.
        tauri_winres::WindowsResource::new()
            .set("ProductName", "Netrix")
            .compile_for(&["netrix_backend"])?;
    }
    Ok(())
}
