import { runAgentService } from "@somework/agent-kit";
import { datadogTriageHooksFor } from "./hooks.ts";
import { profile } from "./profile.ts";
import { roleEnvironment } from "./settings.ts";

runAgentService({ profile, hooks: datadogTriageHooksFor, env: roleEnvironment(process.env) });
