import { runAgentService } from "@somework/agent-kit";
import { productManagerHooksFor } from "./hooks.ts";
import { profile } from "./profile.ts";

runAgentService({ profile, hooks: productManagerHooksFor });
