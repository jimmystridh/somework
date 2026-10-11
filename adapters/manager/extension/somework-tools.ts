import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerApprovalGate, registerSomeworkTools } from "./tools.ts";

export default function somework(pi: ExtensionAPI) {
	registerSomeworkTools(pi as never, Type, process.env);
	registerApprovalGate(pi as never, process.env);
}
