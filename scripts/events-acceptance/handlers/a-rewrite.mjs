// @topics acceptance.rewrite.*
export default async ({ event }) => ({
	action: "rewrite",
	reason: "stamp the data",
	event: { topic: event.topic, classification: event.classification, data: { ...event.data, stamped: true } },
});
