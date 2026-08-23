import type { Config } from "drizzle-kit";

export default {
  schema: ["./src/schema.ts", "./src/schema-app.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
} satisfies Config;
