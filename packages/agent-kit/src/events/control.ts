import type { InboundMessage } from "../chat.ts";
import type { Log } from "../log.ts";
import type { HandlerStore } from "./store.ts";

/** A message carrying this label is a control message for the event handlers, not chat. Values: disable, enable, disable-all, enable-all. */
export const CONTROL_LABEL = "eventControl";
/** The handler a `disable` or `enable` is about. */
export const CONTROL_TARGET_LABEL = "eventTarget";
export const CONTROL_REASON_LABEL = "eventReason";

export const CONTROL_ACTIONS = ["disable", "enable", "disable-all", "enable-all"] as const;

/**
 * The domain-side kill switch. The domain has no API for it, so it rides on an ordinary direct message: the manager (or any sender listed
 * in `controllers`) sends the agent a message with the labels above, and the kit applies it to the handler control file. A message from
 * anyone else is logged and ignored. Returning true tells the chat responder the message is dealt with and must not get a chat notice.
 */
export function createControlIntercept(options: { store: HandlerStore; controllers: readonly string[]; log: Log }): (message: InboundMessage) => Promise<boolean> {
	return async (message) => {
		const action = message.labels?.[CONTROL_LABEL];
		if (action === undefined) return false;
		if (!options.controllers.includes(message.sender.id)) {
			options.log("warn", "event_control_refused", { from: message.sender.id, action, reason: "sender is not a controller" });
			return true;
		}
		const target = message.labels?.[CONTROL_TARGET_LABEL];
		const reason = message.labels?.[CONTROL_REASON_LABEL] || `switched off by ${message.sender.id}`;
		try {
			if (action === "disable-all") options.store.disableAll(reason, message.sender.id);
			else if (action === "enable-all") options.store.enableAll();
			else if (action === "disable" && target) options.store.disable(target, reason, message.sender.id);
			else if (action === "enable" && target) options.store.enable(target);
			else {
				options.log("warn", "event_control_refused", { from: message.sender.id, action, reason: "unknown action or missing target" });
				return true;
			}
			options.log("info", "event_control_applied", { from: message.sender.id, action, target });
		} catch (error) {
			options.log("warn", "event_control_failed", { from: message.sender.id, action, error: String(error).slice(0, 160) });
		}
		return true;
	};
}
