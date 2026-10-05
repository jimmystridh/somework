import { readFileSync } from "node:fs";
import { createSandboxServer } from "./server.ts";

const token = readFileSync(process.env.SANDBOX_TOKEN_FILE ?? "/run/secrets/sandbox-token", "utf8").trim();
if (token.length < 32) throw new Error("the sandbox token must be at least 32 characters");
const root = process.env.SANDBOX_ROOT ?? "/workspace";
const port = Number(process.env.SANDBOX_PORT ?? 7070);
// commands get only these names from the daemon's environment (the egress proxy settings); nothing else, ever
const pass = (process.env.SANDBOX_PASS_ENV ?? "HTTPS_PROXY,HTTP_PROXY,NO_PROXY,https_proxy,http_proxy,no_proxy").split(",");
const baseEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: root, LANG: "C.UTF-8" };
for (const name of pass) if (process.env[name]) baseEnv[name] = process.env[name]!;
const server = createSandboxServer({ token, root, baseEnv });
server.listen(port, process.env.SANDBOX_HOST ?? "0.0.0.0", () => console.error(JSON.stringify({ event: "sandbox_listening", port, root })));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
