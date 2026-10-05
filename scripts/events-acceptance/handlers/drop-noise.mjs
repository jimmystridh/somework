// @topics acceptance.noise.*
export default async ({ event }) => ({ action: "drop", reason: `noise: ${event.topic}` });
