import type { Log } from "../log.ts";
import { silent } from "../log.ts";

/** The id of a job: also its workspace name and the request id of its model run, so it holds only characters that are safe in all of those. */
export const JOB_PREFIX = "job-";
export const isJobId = (value: unknown): value is string => typeof value === "string" && value.startsWith(JOB_PREFIX);

export interface UploadOptions {
	filename: string;
	mediaType: string;
	bytes: Uint8Array | string;
	classification?: string;
	sourceTaskId?: string;
}

/**
 * What a job does with the artifacts it makes. A job runs through the role's handler as a synthetic task that the domain has no record of, so
 * an upload naming it as the source task would be refused. The agent's client is wrapped with this: an upload for a job goes to the domain
 * without a source task, and the reference it returns is kept for the job, so the result message can carry it. Any other call that names a
 * job's task is skipped; nothing about anything else changes.
 */
export class JobArtifacts {
	readonly #log: Log;
	readonly #refs = new Map<string, unknown[]>();

	constructor(options: { log?: Log } = {}) {
		this.#log = options.log ?? silent;
	}

	wrap<T extends object>(client: T): T {
		const self = this;
		return new Proxy(client, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				if (property === "uploadArtifact") {
					return async (options: UploadOptions) => {
						const jobId = options?.sourceTaskId;
						if (!isJobId(jobId)) return value.call(target, options);
						const { sourceTaskId: _job, ...rest } = options;
						const ref = await value.call(target, rest);
						const list = self.#refs.get(jobId) ?? [];
						list.push(ref);
						self.#refs.set(jobId, list);
						self.#log("info", "job_artifact_uploaded", { jobId, filename: options.filename });
						return ref;
					};
				}
				return (...args: unknown[]) => {
					const path = typeof args[0] === "string" ? args[0] : "";
					if (path.includes(`/tasks/${JOB_PREFIX}`)) {
						self.#log("info", "job_task_call_skipped", { method: String(property), path: path.slice(0, 80) });
						return Promise.resolve({});
					}
					return value.apply(target, args);
				};
			},
		});
	}

	/** The references of what a job uploaded, once. */
	take(jobId: string): unknown[] {
		const list = this.#refs.get(jobId) ?? [];
		this.#refs.delete(jobId);
		return list;
	}
}
