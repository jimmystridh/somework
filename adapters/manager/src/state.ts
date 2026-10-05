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
