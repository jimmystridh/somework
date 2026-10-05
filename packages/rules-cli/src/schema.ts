/** The subset of JSON Schema the rule schema and the capability cards use. Anything outside it is refused loudly rather than ignored. */
export interface Schema {
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	required?: string[];
	properties?: Record<string, Schema>;
	additionalProperties?: boolean | Schema;
	items?: Schema;
	minItems?: number;
	maxItems?: number;
	anyOf?: Schema[];
	oneOf?: Schema[];
	description?: string;
	[annotation: string]: unknown;
}

export interface SchemaIssue {
	path: string;
	message: string;
}

const SUPPORTED = new Set(["type", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "anyOf", "oneOf"]);
const ANNOTATIONS = new Set(["description", "title", "$schema", "$id", "default", "examples", "$comment", "format"]);

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

const matchesType = (value: unknown, type: string): boolean => (type === "number" ? typeof value === "number" : typeOf(value) === type);

export function validateSchema(value: unknown, schema: Schema, path = ""): SchemaIssue[] {
	for (const keyword of Object.keys(schema)) {
		if (!SUPPORTED.has(keyword) && !ANNOTATIONS.has(keyword)) throw new Error(`unsupported JSON Schema keyword ${JSON.stringify(keyword)} at ${path || "/"}`);
	}
	const issues: SchemaIssue[] = [];
	const add = (message: string) => issues.push({ path: path || "/", message });

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((type) => matchesType(value, type))) {
			add(`must be ${types.join(" or ")}, got ${typeOf(value)}`);
			return issues;
		}
	}
	if (schema.const !== undefined && value !== schema.const) add(`must equal ${JSON.stringify(schema.const)}`);
	if (schema.enum && !schema.enum.some((option) => option === value)) add(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) add(`must have at least ${schema.minLength} characters`);
		if (schema.maxLength !== undefined && value.length > schema.maxLength) add(`must have at most ${schema.maxLength} characters`);
		if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) add(`must match ${schema.pattern}`);
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) add(`must be at least ${schema.minimum}`);
		if (schema.maximum !== undefined && value > schema.maximum) add(`must be at most ${schema.maximum}`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) add(`must have at least ${schema.minItems} items`);
		if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`must have at most ${schema.maxItems} items`);
		if (schema.items) value.forEach((item, index) => issues.push(...validateSchema(item, schema.items!, `${path}/${index}`)));
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const object = value as Record<string, unknown>;
		for (const name of schema.required ?? []) if (!(name in object)) issues.push({ path: `${path}/${name}`, message: "is required" });
		for (const [name, child] of Object.entries(object)) {
			const known = schema.properties?.[name];
			if (known) issues.push(...validateSchema(child, known, `${path}/${name}`));
			else if (schema.additionalProperties === false) issues.push({ path: `${path}/${name}`, message: "is not allowed" });
			else if (typeof schema.additionalProperties === "object") issues.push(...validateSchema(child, schema.additionalProperties, `${path}/${name}`));
		}
	}
	if (schema.anyOf && !schema.anyOf.some((option) => validateSchema(value, option, path).length === 0)) add("matches none of the allowed shapes");
	if (schema.oneOf && schema.oneOf.filter((option) => validateSchema(value, option, path).length === 0).length !== 1) add("must match exactly one of the allowed shapes");
	return issues;
}

export const formatIssues = (issues: SchemaIssue[]): string[] => issues.map((issue) => `${issue.path} ${issue.message}`);
