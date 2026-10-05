import { runAgentService } from "@somework/agent-kit";
import { reviewerHooksFor } from "./hooks.ts";
import { profile } from "./profile.ts";

runAgentService({ profile, hooks: reviewerHooksFor });
