// @topics acceptance.slow.*
export default async () => {
	await new Promise((resolve) => setTimeout(resolve, 60_000));
	return { action: "drop", reason: "never reached" };
};
