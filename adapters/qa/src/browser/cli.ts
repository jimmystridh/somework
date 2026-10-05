import { CliUsageError, parseCli, send } from "./client.ts";

// qa-browser: the model's handle on the verification's browser. See client.ts for the commands.
try {
	console.log(await send(parseCli(process.argv.slice(2))));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(error instanceof CliUsageError ? 2 : 1);
}
