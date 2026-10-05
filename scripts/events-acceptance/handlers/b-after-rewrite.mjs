// @topics acceptance.rewrite.*
export default async ({ event }) => (event.data.stamped === true ? { action: "deliver", reason: "saw the stamped data" } : { action: "drop", reason: "not stamped" });
