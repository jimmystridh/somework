// @topics acceptance.alert.*
export default async () => ({
	action: "wake",
	tier: "small",
	reason: "alert needs a look",
	prompt: "Acceptance test. Answer with the single word ACK and nothing else. Do not run any command and do not use any tool.",
});
