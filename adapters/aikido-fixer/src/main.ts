import { runAgentService } from "@somework/agent-kit";
import { aikidoFixerHooksFor } from "./hooks.ts";
import { profile } from "./profile.ts";
import { roleEnvironment } from "./settings.ts";

runAgentService({ profile, hooks: aikidoFixerHooksFor, env: roleEnvironment(process.env) });
