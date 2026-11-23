// Writes gateway.config.schema.json from the zod schema, for editor autocomplete.
// Run after `npm run build`: node scripts/gen-schema.mjs
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { GatewayConfigSchema } from "../dist/config.js";

const schema = z.toJSONSchema(GatewayConfigSchema, { io: "input", unrepresentable: "any" });
schema.title = "mcp-approval-gateway config";
writeFileSync(
  new URL("../gateway.config.schema.json", import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
console.log("wrote gateway.config.schema.json");
