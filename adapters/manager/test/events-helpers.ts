import { TelegramBridge } from "../src/bridge.ts";
import { Controls, type ControlsConfig } from "../src/controls.ts";
import type { DomainApproval, RuleSummary } from "../src/domain.ts";
import { EventIntake, type EventIntakeConfig } from "../src/event-intake.ts";
import { Notifications, TaskTracker } from "../src/notifier.ts";
import { defaultPolicy } from "../src/policy.ts";
import { ReactionApprovals } from "../src/reaction-approvals.ts";
import { ManagerService } from "../src/service.ts";
import type { ManagerState } from "../src/state.ts";
import { FakeDomain, recordingApi, stubRpc } from "./helpers.ts";

export const OWNER = 42;

export const approval = (id: string, extra: Partial<DomainApproval> = {}): DomainApproval => ({
	approvalId: id,
	taskId: `task_for_${id}`,
	taskRevision: 3,
	actionDigest: `digest-of-${id}`,
	action: "qa.verify@1",
	requestedBy: "agent/automation/qa-on-ticket",
	status: "pending",
	expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
	...extra,
});

export const rule = (name: string, extra: Partial<RuleSummary> = {}): RuleSummary => ({
	name,
	description: "",
	owner: "agent/automation/qa-on-ticket",
	selector: "jira.issue.transitioned",
	wake: false,
	status: "active",
	lastFiredAt: null,
	counters: { fired: 0, skipped: {} },
	...extra,
});

export interface Calls {
	url: string;
	method?: string;
	authorization?: string;
}

/** Everything wired as in main.ts, with fakes for Telegram, Pi, the domain, the hub and the agents' health endpoints. */
export function build(options: { paired?: boolean; controls?: Partial<ControlsConfig>; events?: Partial<EventIntakeConfig>; http?: (url: string, method?: string) => { status: number; text: string }; now?: () => number } = {}) {
	const domain = new FakeDomain();
	const telegram = recordingApi();
	const notifications = new Notifications();
	const state: ManagerState = options.paired === false ? {} : { allowedUserId: OWNER, chatId: OWNER };
	const saves: number[] = [];
	const save = async () => void saves.push(Date.now());
	const tracker = new TaskTracker(domain, state, save, notifications);
	const { rpc, calls: rpcCalls } = stubRpc();
	const bridge = new TelegramBridge({ state, api: telegram.api, rpc, save, tracker, notifications, now: options.now });
	const httpCalls: Calls[] = [];
	const controls = new Controls({
		domain,
		state,
		save,
		config: { agentHealth: {}, ...options.controls },
		tasks: () => tracker.tasks,
		localPendingApprovals: () => service.pending().length,
		domainPendingApprovals: async () => (await reactionApprovals.pending()).length,
		http: async (url, opts) => {
			httpCalls.push({ url, method: opts?.method, authorization: opts?.headers?.authorization });
			return (options.http ?? (() => ({ status: 404, text: "" })))(url, opts?.method);
		},
		readToken: async () => "hub-admin-token\n",
	});
	const reactionApprovals = new ReactionApprovals({ domain, owner: bridge, state, save, now: options.now });
	const service: ManagerService = new ManagerService({ domain, policy: defaultPolicy, owner: bridge, tracker, reactionApprovals, controls, now: options.now });
	bridge.service = service;
	const intake = new EventIntake({ domain, owner: bridge, state, save, config: options.events, digest: () => controls.digest(), now: options.now });
	return { domain, telegram, bridge, service, state, saves, reactionApprovals, controls, intake, httpCalls, rpcCalls, tracker };
}

export const say = (b: ReturnType<typeof build>, text: string, from = OWNER) =>
	b.bridge.handleUpdate({ update_id: 1, message: { from: { id: from, is_bot: false }, chat: { id: from, type: "private" }, text, date: Math.floor(Date.now() / 1000) } });

export const tap = (b: ReturnType<typeof build>, data: string, from = OWNER, chatId = OWNER) =>
	b.bridge.handleUpdate({ update_id: 2, callback_query: { id: "cb1", from: { id: from }, message: { message_id: 100, chat: { id: chatId, type: "private" } }, data } });

export const publishedEvent = (seq: number, topic: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	seq,
	eventId: `evt_${seq}`,
	type: topic,
	payload: { topic, source: topic.split(".")[0], key: `k${seq}`, data, classification: "internal", verified: true, depth: 0, ...extra },
});
