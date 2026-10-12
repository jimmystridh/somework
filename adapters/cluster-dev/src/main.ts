import { runAgentService } from "@somework/agent-kit";
import { clusterDevHooksFor } from "./hooks.ts";
import { profile } from "./profile.ts";
import { roleEnvironment } from "./settings.ts";

runAgentService({ profile, hooks: clusterDevHooksFor, env: roleEnvironment(process.env) });
