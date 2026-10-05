// Generates the agent's SomeWork identity on the machine that will use it, so the private key never travels.
//   node deploy/keygen.ts --id agent/windows-developer --domain development --out C:\somework\secrets\agent.key.json
// Prints the public key; give that to `somework admin enroll-agent --public-key`. The file has the same format as the one written by
// `somework-sidecar keygen`. It refuses to overwrite an existing file.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

export function generateKeyFile(id: string, domainId: string): { file: Record<string, string>; publicKey: string } {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
	const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	return { file: { kind: "agent", id, domainId, privateKey: seed.toString("base64url"), publicKey: pub.toString("base64url") }, publicKey: pub.toString("base64url") };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop()!)) {
	const args = new Map<string, string>();
	for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
	const id = args.get("id");
	const out = args.get("out");
	if (!id || !out || !/^agent\/[a-z0-9][a-z0-9._-]*$/.test(id)) {
		console.error("usage: node deploy/keygen.ts --id agent/<name> [--domain development] --out <key file>");
		process.exit(2);
	}
	const { file, publicKey } = generateKeyFile(id, args.get("domain") ?? "development");
	writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	console.log(JSON.stringify({ id, domainId: file.domainId, keyFile: out, publicKey }));
}
