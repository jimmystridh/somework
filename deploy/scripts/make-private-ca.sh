#!/usr/bin/env bash
# Creates a private CA and server certificates for the pilot (domain TLS proxy and NATS). Run it on a trusted machine and
# distribute only: ca.pem (to every worker and to the domain), and each server's cert + key (to that server).
#
#   deploy/scripts/make-private-ca.sh OUT_DIR domain=somework.internal,10.0.0.5 nats=nats,nats.internal,10.0.0.5
#
# Each `name=SAN,SAN,...` entry issues OUT_DIR/name.pem and name.key; SANs that look like IPs become IP SANs.
set -euo pipefail
umask 077
out="${1:?usage: make-private-ca.sh OUT_DIR name=SAN,SAN ...}"; shift
mkdir -p "$out"
cd "$out"

if [ ! -f ca.key ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out ca.key
  printf 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > ca.ext
  openssl req -new -key ca.key -subj "/CN=SomeWork pilot CA" -out ca.csr
  openssl x509 -req -in ca.csr -signkey ca.key -days 3650 -sha256 -extfile ca.ext -out ca.pem
  rm -f ca.csr ca.ext
fi

for spec in "$@"; do
  name="${spec%%=*}"; sans="${spec#*=}"
  san_list=""
  IFS=',' read -ra items <<< "$sans"
  for item in "${items[@]}"; do
    if [[ "$item" =~ ^[0-9.]+$ || "$item" == *:* ]]; then san_list+="IP:$item,"; else san_list+="DNS:$item,"; fi
  done
  openssl ecparam -name prime256v1 -genkey -noout -out "$name.key"
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n' "${san_list%,}" > "$name.ext"
  openssl req -new -key "$name.key" -subj "/CN=$name" -out "$name.csr"
  openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile "$name.ext" -out "$name.pem"
  rm -f "$name.csr" "$name.ext"
  echo "issued $name.pem for ${sans}"
done
# the CA private key never leaves this machine; servers and workers only need ca.pem
chmod 600 ./*.key
echo "distribute ca.pem everywhere; keep ca.key offline"
