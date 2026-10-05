fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR")?);
    let mut config = tonic_prost_build::Config::new();
    config.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure().file_descriptor_set_path(out.join("somework_descriptor.bin")).compile_with_config(
        config,
        &["proto/somework/v1/somework.proto"],
        &["proto"],
    )?;
    println!("cargo:rerun-if-changed=proto/somework/v1/somework.proto");
    Ok(())
}
