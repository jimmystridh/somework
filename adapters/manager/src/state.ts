import { readFile, rename, writeFile } from "node:fs/promises";

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
	/** Position in the domain event feed and the last event ids handled, so an event is forwarded once. */
	eventCursor?: number;
	seenEvents?: string[];
	/** Set once the manager has asked the domain for the job-finished events of every agent. */
	jobSubscription?: boolean;
	/** Forwarded-event lines held back during quiet hours. */
	quietQueue?: string[];
	/** Conversations the owner started with agents through /ask, by conversation id. */
	chats?: Record<string, ChatRecord>;
	/** Approval questions an agent put to the owner for a step of its work, by the agent's request id. */
	chatApprovals?: Record<string, ChatApprovalRecord>;
	/** Sources the owner paused from here (the hub does not report it). */
	sourcesPaused?: Record<string, boolean>;
	/** Set while the owner has suspended everything: what /suspend changed, so /unsuspend puts back exactly that and nothing else. */
	suspended?: SuspendRecord;
}

export interface SuspendRecord {
	at: string;
	reason?: string;
	rules: string[];
	sources: string[];
	agents: string[];
}

export interface ChatApprovalRecord {
	agent: string;
	conversationId: string;
	askedAt: string;
}

export interface ChatRecord {
	agent: string;
	/** All the agents of a group conversation (several recipients in one conversation); absent for a chat with one agent. */
	agents?: string[];
	/** What the owner wants done when the answer comes: the Manager is woken with the answer and this, once. */
	then?: string;
	startedAt: string;
	lastSentAt: string;
	/** Set while the last message has no answer yet; cleared by a reply. */
	awaitingSince?: string;
	repliedAt?: string;
	timeoutNotified?: boolean;
}

export type SaveState = (state: ManagerState) => Promise<void>;

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
