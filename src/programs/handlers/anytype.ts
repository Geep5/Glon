// Anytype — shell cheatsheet, not a wrapper.
//
// Anytype runs a local REST API on 127.0.0.1:31009 and ships an MCP server
// (@anyproto/anytype-mcp) for the OpenAPI surface. We don't re-implement
// either; Graice talks to it via shell_exec curl using the env vars.
// This program exists as REPL-side documentation so a human (or Graice
// herself) can quickly recall the auth headers and a few common recipes.
//
// Setup: in a real terminal, `npx -y @anyproto/anytype-mcp get-key`.
// Anytype will display a 4-digit code; enter it, copy the issued key into
// `.env` as ANYTYPE_API_KEY. Anytype-Version is pinned to the API spec
// date; bump it when @anyproto/anytype-mcp updates.

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m"; const BOLD = "\x1b[1m"; const CYAN = "\x1b[36m"; const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

const handler = async (_cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	const base = process.env.ANYTYPE_API_BASE ?? "http://127.0.0.1:31009";
	const ver = process.env.ANYTYPE_VERSION ?? "2025-11-08";
	const keyState = process.env.ANYTYPE_API_KEY ? cyan("set") : dim("(not set — run get-key)");
	print([
		bold("  Anytype") + dim(" — local REST API; talk to it from shell."),
		"",
		`    base   ${cyan(base)}`,
		`    api key ${keyState}`,
		`    version ${cyan(ver)}`,
		"",
		dim("  One-time setup (interactive — needs a real terminal):"),
		`    ${cyan("npx -y @anyproto/anytype-mcp get-key")}    ${dim("# enter the 4-digit code Anytype shows")}`,
		dim("  then add the issued key to .env as ANYTYPE_API_KEY."),
		"",
		dim("  Recipes (run via shell_exec):"),
		`    ${cyan(`curl -sH "Authorization: Bearer $ANYTYPE_API_KEY" -H "Anytype-Version: $ANYTYPE_VERSION" $ANYTYPE_API_BASE/v1/spaces`)}`,
		`    ${cyan(`curl -sH "Authorization: Bearer $ANYTYPE_API_KEY" -H "Anytype-Version: $ANYTYPE_VERSION" $ANYTYPE_API_BASE/v1/spaces/<SPACE_ID>/objects?limit=20`)}`,
		`    ${cyan(`curl -sH "Authorization: Bearer $ANYTYPE_API_KEY" -H "Anytype-Version: $ANYTYPE_VERSION" -H "Content-Type: application/json" -X POST $ANYTYPE_API_BASE/v1/spaces/<SPACE_ID>/search -d '{"query":"..."}'`)}`,
		"",
		dim("  Full spec: https://developers.anytype.io"),
	].join("\n"));
};

const program: ProgramDef = { handler };
export default program;
