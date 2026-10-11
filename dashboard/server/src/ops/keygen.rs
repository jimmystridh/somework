//! `fleet-server --operations-keygen --domain <id> --out <file>`: makes the signing key of the `operations` service principal on the host
//! that will use it, so the private key never travels. Prints the public key for `somework admin enroll-service --public-key`.
//! The file has the format every SomeWork key file has (`kind`, `id`, `domainId`, `privateKey`, `publicKey`, base64url).

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use fleet_shared::operations::{OPERATIONS_PRINCIPAL_ID, OPERATIONS_PRINCIPAL_KIND};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{io::Write, path::Path};

/// The key file's contents and the public key.
pub fn generate(domain_id: &str) -> (serde_json::Value, String) {
    let mut seed = [0u8; 32];
    SystemRandom::new().fill(&mut seed).expect("system randomness");
    let pair = Ed25519KeyPair::from_seed_unchecked(&seed).expect("a 32 byte seed");
    let public = URL_SAFE_NO_PAD.encode(pair.public_key().as_ref());
    let file = serde_json::json!({
        "kind": OPERATIONS_PRINCIPAL_KIND,
        "id": OPERATIONS_PRINCIPAL_ID,
        "domainId": domain_id,
        "privateKey": URL_SAFE_NO_PAD.encode(seed),
        "publicKey": public,
    });
    (file, public)
}

/// Writes the key file readable by its owner only and never over an existing file. Returns the public key.
pub fn write(path: &Path, domain_id: &str) -> Result<String, String> {
    if domain_id.is_empty() || !domain_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err("--domain must be the domain's id (letters, digits, - _ .)".into());
    }
    let (file, public) = generate(domain_id);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut handle = options.open(path).map_err(|error| format!("cannot create {}: {error}", path.display()))?;
    handle.write_all(format!("{}\n", serde_json::to_string_pretty(&file).expect("serialises")).as_bytes()).map_err(|error| error.to_string())?;
    Ok(public)
}

/// The command line: `--operations-keygen --domain <id> --out <file>`. Returns the line to print.
pub fn run(args: &[String]) -> Result<String, String> {
    let value = |name: &str| args.iter().position(|arg| arg == name).and_then(|index| args.get(index + 1)).cloned();
    let domain = value("--domain").ok_or("usage: fleet-server --operations-keygen --domain <domain id> --out <key file>")?;
    let out = value("--out").ok_or("usage: fleet-server --operations-keygen --domain <domain id> --out <key file>")?;
    let public = write(Path::new(&out), &domain)?;
    Ok(serde_json::json!({"id": OPERATIONS_PRINCIPAL_ID, "kind": OPERATIONS_PRINCIPAL_KIND, "domainId": domain, "keyFile": out, "publicKey": public}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ops-keygen-{}-{name}", std::process::id()))
    }

    #[test]
    fn the_key_file_is_a_usable_operations_key_with_a_matching_public_key() {
        let path = scratch("usable");
        let _ = std::fs::remove_file(&path);
        let public = write(&path, "development").unwrap();
        let contents = std::fs::read(&path).unwrap();
        let file: serde_json::Value = serde_json::from_slice(&contents).unwrap();
        assert_eq!((file["kind"].as_str(), file["id"].as_str(), file["domainId"].as_str()), (Some("service"), Some("operations"), Some("development")));
        assert_eq!(file["publicKey"], public.as_str());
        let seed = URL_SAFE_NO_PAD.decode(file["privateKey"].as_str().unwrap()).unwrap();
        let pair = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()), public, "the public key is the one of the private key");
        assert!(crate::ops::client_from_key("http://127.0.0.1:1", &contents, None, None).is_ok());
        assert!(crate::assertion::Identity::from_key_file(&contents).is_ok(), "the collector's own reader takes it too");
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions()) & 0o777, 0o600);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_existing_key_is_never_overwritten_and_every_key_is_new() {
        let path = scratch("existing");
        let _ = std::fs::remove_file(&path);
        write(&path, "development").unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(write(&path, "development").unwrap_err().contains("cannot create"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_ne!(generate("d").1, generate("d").1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_command_line_needs_both_arguments_and_a_sane_domain() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(run(&args(&["--operations-keygen"])).is_err());
        assert!(run(&args(&["--operations-keygen", "--domain", "d"])).is_err());
        assert!(run(&args(&["--operations-keygen", "--domain", "../x", "--out", "/nowhere/x"])).is_err());
        let path = scratch("cli");
        let _ = std::fs::remove_file(&path);
        let printed = run(&args(&["--operations-keygen", "--domain", "development", "--out", path.to_str().unwrap()])).unwrap();
        assert!(printed.contains("\"publicKey\"") && !printed.contains("privateKey"), "{printed}");
        let _ = std::fs::remove_file(&path);
    }
}
