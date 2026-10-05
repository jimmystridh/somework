import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSomeworkTools } from "./tools.ts";

export default function somework(pi: ExtensionAPI) {
	registerSomeworkTools(pi as never, Type, process.env);
}
