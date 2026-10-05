//! Envelope protection for signing keys at rest. A production deployment would hold the master key in a KMS/HSM;
//! the interface (`seal`/`open`) is what a KMS-backed implementation would replace.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use somework_core::{Error, jws};

#[derive(Clone)]
pub struct MasterKey([u8; 32]);

impl MasterKey {
    pub fn generate() -> Self {
        Self(rand::random())
    }

    pub fn from_b64(raw: &str) -> Result<Self, Error> {
        let bytes: [u8; 32] = jws::unb64(raw)
            .map_err(|_| Error::internal("master key is not valid base64url"))?
            .try_into()
            .map_err(|_| Error::internal("master key must be 32 bytes"))?;
        Ok(Self(bytes))
    }

    pub fn to_b64(&self) -> String {
        jws::b64(&self.0)
    }

    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> String {
        let cipher = Aes256Gcm::new((&self.0).into());
        let nonce_bytes: [u8; 12] = rand::random();
        let ciphertext = cipher
            .encrypt(&Nonce::try_from(nonce_bytes.as_slice()).expect("12 byte nonce"), aes_gcm::aead::Payload { msg: plaintext, aad })
            .expect("AES-GCM encryption cannot fail for in-memory buffers");
        format!("{}.{}", jws::b64(&nonce_bytes), jws::b64(&ciphertext))
    }

    pub fn open(&self, sealed: &str, aad: &[u8]) -> Result<Vec<u8>, Error> {
        let (nonce, ciphertext) = sealed.split_once('.').ok_or_else(|| Error::internal("malformed sealed secret"))?;
        let nonce = jws::unb64(nonce)?;
        if nonce.len() != 12 {
            return Err(Error::internal("malformed sealed secret nonce"));
        }
        let cipher = Aes256Gcm::new((&self.0).into());
        cipher
            .decrypt(&Nonce::try_from(nonce.as_slice()).expect("12 byte nonce"), aes_gcm::aead::Payload { msg: &jws::unb64(ciphertext)?, aad })
            .map_err(|_| Error::internal("sealed secret failed authentication"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip_binds_aad() {
        let key = MasterKey::generate();
        let sealed = key.seal(b"secret", b"kid-1");
        assert_eq!(key.open(&sealed, b"kid-1").unwrap(), b"secret");
        assert!(key.open(&sealed, b"kid-2").is_err());
        assert!(MasterKey::generate().open(&sealed, b"kid-1").is_err());
    }
}
