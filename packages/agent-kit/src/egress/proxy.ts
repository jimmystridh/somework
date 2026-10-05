import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, isIP, type Socket } from "node:net";

export interface EgressOptions {
	/** Hostnames the sandbox may reach: exact (`github.com`) or `*.suffix`. Everything else is refused. */
	allowHosts: string[];
	/** Destination ports (default 443 and 80). */
	allowPorts?: number[];
	/** Tests only: permit loopback/private destinations. In production the proxy refuses them, so the sandbox can never reach the
	 * domain, the broker, the host or cloud metadata through it, even if an allowed name resolved to one. */
	allowPrivate?: boolean;
	log?: (event: string, fields: Record<string, unknown>) => void;
}

export function isPrivateAddress(address: string): boolean {
	if (address.includes(":")) {
		const a = address.toLowerCase();
		return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb") || a.startsWith("::ffff:") && isPrivateAddress(a.slice(7));
	}
	const [a, b] = address.split(".").map(Number) as [number, number];
	return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function hostAllowed(host: string, allow: string[]): boolean {
	const name = host.toLowerCase().replace(/\.$/, "");
	return allow.some((pattern) => {
		const p = pattern.toLowerCase();
		return p.startsWith("*.") ? name.endsWith(p.slice(1)) && name.length > p.length - 1 : name === p;
	});
}

/** A CONNECT/forward proxy with an allowlist: the only way out of the sandbox network. */
export function createEgressProxy(options: EgressOptions): Server {
	const ports = new Set(options.allowPorts ?? [443, 80]);
	const log = options.log ?? (() => {});

	async function resolveAllowed(host: string, port: number): Promise<{ address: string } | { denied: string }> {
		if (!hostAllowed(host, options.allowHosts)) return { denied: "host not on the allowlist" };
		if (!ports.has(port)) return { denied: "port not allowed" };
		// prefer IPv4 (the sandbox network is IPv4; `localhost` otherwise resolves to ::1 first), fall back to whatever resolves
		const address = isIP(host) ? host : (await lookup(host, { family: 4 }).catch(() => lookup(host))).address;
		if (!options.allowPrivate && isPrivateAddress(address)) return { denied: "destination is a private address" };
		return { address };
	}

	const server = createServer(async (req, res) => {
		// plain-http forwarding: the request line carries an absolute URL
		try {
			const target = new URL(req.url ?? "");
			const verdict = await resolveAllowed(target.hostname, Number(target.port || 80));
			if ("denied" in verdict) {
				log("egress_denied", { host: target.hostname, reason: verdict.denied });
				return void res.writeHead(403, { "content-type": "text/plain" }).end(`egress denied: ${verdict.denied}\n`);
			}
			const upstream = httpRequest({ host: verdict.address, port: Number(target.port || 80), method: req.method, path: target.pathname + target.search, headers: { ...req.headers, host: target.host } }, (reply) => {
				res.writeHead(reply.statusCode ?? 502, reply.headers);
				reply.pipe(res);
			});
			upstream.on("error", () => res.headersSent || res.writeHead(502).end());
			req.pipe(upstream);
		} catch {
			res.writeHead(400).end();
		}
	});

	server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
		const [host, rawPort] = (req.url ?? "").split(":");
		const port = Number(rawPort || 443);
		try {
			const verdict = await resolveAllowed(host ?? "", port);
			if ("denied" in verdict) {
				log("egress_denied", { host, port, reason: verdict.denied });
				return void client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\negress denied: ${verdict.denied}\n`);
			}
			const upstream = connect(port, verdict.address, () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				upstream.pipe(client);
				client.pipe(upstream);
			});
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
			client.on("close", () => upstream.destroy());
		} catch {
			client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		}
	});
	return server;
}
