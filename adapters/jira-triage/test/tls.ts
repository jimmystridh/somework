import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TestTls {
	ca: string;
	serverCert: string;
	serverKey: string;
	clientPfx: Buffer;
	clientPassphrase: string;
	/** A client certificate from a CA the server does not trust. */
	strangerPfx: Buffer;
}

/** A throwaway CA, a server certificate for 127.0.0.1 and a client certificate in a PKCS#12 file, made with the openssl command line. */
export function makeTls(dir: string): TestTls {
	mkdirSync(dir, { recursive: true });
	const at = (name: string) => join(dir, name);
	const run = (...args: string[]) => {
		const out = spawnSync("openssl", args, { encoding: "utf8" });
		if (out.status !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${out.stderr}`);
	};
	const authority = (name: string) => {
		run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", at(`${name}.key`));
		run("req", "-x509", "-new", "-key", at(`${name}.key`), "-subj", `/CN=${name}`, "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-out", at(`${name}.pem`));
	};
	const leaf = (name: string, authorityName: string, subject: string, extensions: string) => {
		writeFileSync(at(`${name}.ext`), extensions);
		run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", at(`${name}.key`));
		run("req", "-new", "-key", at(`${name}.key`), "-subj", `/CN=${subject}`, "-out", at(`${name}.csr`));
		run("x509", "-req", "-in", at(`${name}.csr`), "-CA", at(`${authorityName}.pem`), "-CAkey", at(`${authorityName}.key`), "-CAcreateserial", "-days", "2", "-extfile", at(`${name}.ext`), "-out", at(`${name}.pem`));
	};
	const passphrase = "test-pfx-password";
	authority("ca");
	authority("other-ca");
	leaf("server", "ca", "localhost", "basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n");
	leaf("client", "ca", "triage-client", "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n");
	leaf("stranger", "other-ca", "stranger", "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n");
	for (const name of ["client", "stranger"]) run("pkcs12", "-export", "-inkey", at(`${name}.key`), "-in", at(`${name}.pem`), "-out", at(`${name}.p12`), "-passout", `pass:${passphrase}`);
	return {
		ca: readFileSync(at("ca.pem"), "utf8"),
		serverCert: readFileSync(at("server.pem"), "utf8"),
		serverKey: readFileSync(at("server.key"), "utf8"),
		clientPfx: readFileSync(at("client.p12")),
		clientPassphrase: passphrase,
		strangerPfx: readFileSync(at("stranger.p12")),
	};
}
