import { readFile, rename, writeFile } from "node:fs/promises";

export interface TrackedTask {
	taskId: string;
	capability: string;
	targetAgentId?: string;
	submittedAt: string;
	state: string;
	/** The last state the owner was told about; a task is announced once per terminal state and once per question. */
	announced?: string;
	/** Telegram message that carries the open question, so a reply to it answers the task. */
	questionMessageId?: number;
}

/** Persisted next to the Telegram bot credentials. The first keys are the old bridge's, kept so its state file is reused as is. */
export interface ManagerState {
	botId?: number;
	allowedUserId?: number;
	chatId?: number;
	sessionId?: string;
	sessionPath?: string;
	lastUpdateId?: number;
	pairingHash?: string;
	pairingCreatedAt?: number;
	pairingExpiresAt?: number;
	tasks?: Record<string, TrackedTask>;
	/** Domain approvals the owner has been told about, so a restart does not ask twice and an outcome is reported once. */
	reactionApprovals?: Record<string, AnnouncedApproval>;
	/** Position in the domain event feed and the last event ids handled, so an event is forwarded once. */
	eventCursor?: number;
	seenEvents?: string[];
	/** Forwarded-event lines held back during quiet hours. */
	quietQueue?: string[];
	/** Conversations the owner started with agents through /ask, by conversation id. */
	chats?: Record<string, ChatRecord>;
	/** Approval questions an agent put to the owner for an instruction the owner gave in chat, by the agent's request id. */
	chatApprovals?: Record<string, ChatApprovalRecord>;
	/** Sources the owner paused from here (the hub does not report it). */
	sourcesPaused?: Record<string, boolean>;
}

export interface ChatApprovalRecord {
	agent: string;
	conversationId: string;
	askedAt: string;
}

export interface ChatRecord {
	agent: string;
	startedAt: string;
	lastSentAt: string;
	/** Set while the last message has no answer yet; cleared by a reply. */
	awaitingSince?: string;
	repliedAt?: string;
	timeoutNotified?: boolean;
}

export interface AnnouncedApproval {
	announcedAt: string;
	status: string;
	messageId?: number;
	/** The outcome (decided elsewhere, expired, superseded) has been reported. */
	reported?: boolean;
}

export type SaveState = (state: ManagerState) => Promise<void>;

export const TERMINAL = new Set(["succeeded", "failed", "rejected", "canceled", "expired"]);

export async function loadState(path: string): Promise<ManagerState> {
	return JSON.parse(await readFile(path, "utf8"));
}

export function fileSaver(path: string): SaveState {
	return async (state) => {
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	};
}
