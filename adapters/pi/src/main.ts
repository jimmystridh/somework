import { runAgentService } from "@somework/agent-kit";
import { developerChat } from "./chat.ts";
import { profile } from "./profile.ts";

runAgentService({ profile, hooks: { chat: developerChat() } });
