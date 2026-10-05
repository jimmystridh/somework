import assert from "node:assert/strict";
import { connect, createServer, type AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createEgressProxy, hostAllowed, isPrivateAddress } from "../src/egress/proxy.ts";

let target: ReturnType<typeof createServer>;
let targetPort: number;
let proxy: ReturnType<typeof createEgressProxy>;
let proxyPort: number;
const denied: string[] = [];

before(async () => {
	target = createServer((socket) => socket.on("data", (d) => socket.write(`echo:${d}`)));
	await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
	targetPort = (target.address() as AddressInfo).port;
	proxy = createEgressProxy({ allowHosts: ["localhost", "*.allowed.test"], allowPorts: [targetPort], allowPrivate: true, log: (_e, f) => denied.push(`${f.host}:${f.reason}`) });
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	proxyPort = (proxy.address() as AddressInfo).port;
});
after(() => {
	proxy.closeAllConnections();
	proxy.close();
	target.close();
});

/** Sends a CONNECT and returns the proxy's first response line plus anything tunnelled afterwards. */
function connectVia(host: string, port: number, payload?: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
		let seen = "";
		socket.on("data", (chunk) => {
			seen += chunk;
			if (payload && seen.includes("200 Connection Established") && !seen.includes("echo:")) socket.write(payload);
			if (seen.includes("echo:") || /HTTP\/1.1 (4|5)\d\d/.test(seen)) socket.end();
		});
		socket.on("close", () => resolve(seen));
		socket.setTimeout(4000, () => socket.destroy());
	});
}

describe("egress allowlist proxy", () => {
	it("tunnels to an allowed host and port", async () => {
		const out = await connectVia("localhost", targetPort, "ping");
		assert.match(out, /200 Connection Established/);
		assert.match(out, /echo:ping/);
	});

	it("refuses a host that is not on the allowlist", async () => {
		assert.match(await connectVia("example.com", 443), /403 Forbidden[\s\S]*not on the allowlist/);
	});

	it("refuses an allowed host on a port that is not allowed", async () => {
		assert.match(await connectVia("localhost", 22), /403 Forbidden[\s\S]*port not allowed/);
	});

	it("refuses plain-http forwarding to a host that is not allowed", async () => {
		const response = await new Promise<string>((resolve) => {
			const socket = connect(proxyPort, "127.0.0.1", () => socket.write("GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n"));
			let seen = "";
			socket.on("data", (d) => (seen += d));
			socket.on("close", () => resolve(seen));
			setTimeout(() => socket.destroy(), 1500);
		});
		assert.match(response, /403/);
	});

	it("records every denial", () => {
		assert.ok(denied.some((d) => d.startsWith("example.com:")));
	});
});

describe("egress rules", () => {
	it("matches exact names and wildcard suffixes only", () => {
		assert.equal(hostAllowed("github.com", ["github.com"]), true);
		assert.equal(hostAllowed("api.github.com", ["*.github.com"]), true);
		assert.equal(hostAllowed("github.com", ["*.github.com"]), false);
		assert.equal(hostAllowed("evilgithub.com", ["*.github.com"]), false);
		assert.equal(hostAllowed("github.com.evil.test", ["github.com"]), false);
	});

	it("recognises private, loopback, link-local and metadata addresses", () => {
		for (const address of ["10.0.0.5", "127.0.0.1", "172.17.0.1", "192.168.1.1", "169.254.169.254", "100.100.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.equal(isPrivateAddress(address), true, address);
		for (const address of ["140.82.121.3", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
	});

	it("in production mode a host that resolves to a private address is refused even if it is on the allowlist", async () => {
		const strict = createEgressProxy({ allowHosts: ["localhost"], allowPorts: [targetPort] });
		await new Promise<void>((resolve) => strict.listen(0, "127.0.0.1", resolve));
		const port = (strict.address() as AddressInfo).port;
		const out = await new Promise<string>((resolve) => {
			const socket = connect(port, "127.0.0.1", () => socket.write(`CONNECT localhost:${targetPort} HTTP/1.1\r\n\r\n`));
			let seen = "";
			socket.on("data", (d) => (seen += d));
			socket.on("close", () => resolve(seen));
			setTimeout(() => socket.destroy(), 1500);
		});
		strict.closeAllConnections();
		strict.close();
		assert.match(out, /403[\s\S]*private address/);
	});
});
