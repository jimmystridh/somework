// @topics acceptance.fail.*
export default async () => {
	throw new Error("acceptance: the handler throws");
};
