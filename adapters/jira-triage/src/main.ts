import { runAgentService } from "@somework/agent-kit";
import { jiraTriageHooksFor } from "./hooks.ts";
import { profile } from "./profile.ts";
import { roleEnvironment } from "./settings.ts";

runAgentService({ profile, hooks: jiraTriageHooksFor, env: roleEnvironment(process.env) });
