import { createEgressProxy } from "./proxy.ts";

const allowHosts = (process.env.EGRESS_ALLOW ?? "").split(",").map((h) => h.trim()).filter(Boolean);
if (allowHosts.length === 0) throw new Error("EGRESS_ALLOW must list at least one host (the proxy refuses everything otherwise)");
const allowPorts = (process.env.EGRESS_PORTS ?? "443,80").split(",").map(Number);
const port = Number(process.env.EGRESS_PORT ?? 8888);
const server = createEgressProxy({ allowHosts, allowPorts, log: (event, fields) => console.error(JSON.stringify({ event, ...fields })) });
server.listen(port, "0.0.0.0", () => console.error(JSON.stringify({ event: "egress_listening", port, allowHosts, allowPorts })));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
