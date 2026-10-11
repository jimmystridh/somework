import type { LocalConversations } from "./engine.ts";
import type { OutgoingMessage, Sender } from "./message.ts";

/** A chat channel's way into its conversations, and which conversations those are. */
export interface SenderRoute {
	sender: Sender;
	store: Pick<LocalConversations, "owns">;
}

/** The conversations of several channels as one: each id is handled by the channel whose prefix it carries. */
export function combinedLocal(stores: readonly LocalConversations[]): LocalConversations {
	const ownerOf = (id: string | undefined): LocalConversations | undefined => stores.find((store) => store.owns(id));
	return {
		owns: (id) => ownerOf(id) !== undefined,
		message: (id) => ownerOf(id)?.message(id),
		history: (conversationId, beforeMessageId, limit, chars) => ownerOf(conversationId)?.history(conversationId, beforeMessageId, limit, chars) ?? [],
	};
}

/** Sends into the conversations of a channel through that channel and everything else through the domain. */
export class RoutedSender implements Sender {
	readonly #domain: Sender;
	readonly #routes: readonly SenderRoute[];

	constructor(domain: Sender, routes: readonly SenderRoute[]);
	constructor(domain: Sender, channel: Sender, store: SenderRoute["store"]);
	constructor(domain: Sender, channelOrRoutes: Sender | readonly SenderRoute[], store?: SenderRoute["store"]) {
		this.#domain = domain;
		this.#routes = Array.isArray(channelOrRoutes) ? channelOrRoutes : [{ sender: channelOrRoutes as Sender, store: store! }];
	}

	send(message: OutgoingMessage): Promise<void> {
		return (this.#routes.find((route) => route.store.owns(message.conversationId))?.sender ?? this.#domain).send(message);
	}
}
