// @topics acceptance.task.*
export default async () => ({
	action: "submit",
	reason: "route the event to a review that is expected to fail at the clone",
	task: {
		capability: { id: "code.review", version: "3" },
		input: { repository: { url: "https://github.com/jimmystridh/acceptance-does-not-exist.git", ref: "main" }, focus: "acceptance test" },
		budget: { maxTokens: 10000, maxMinutes: 2 },
	},
});
