/** The reviewer is read-only by the kit's shared policy: plain inspection runs, mutations are refused, anything else waits for the requester. */
export { classifyCommand, DENIED_REASON, READ_ONLY_APPROVAL_PATTERNS as REVIEW_APPROVAL_PATTERNS, type CommandVerdict } from "@somework/agent-kit";
