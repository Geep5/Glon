// Google Workspace — shell cheatsheet, not a wrapper.
//
// gws (the Google Workspace CLI) already solves auth, refresh, scope
// gating, and encrypted credential storage in the OS keyring. Our agents
// reach Calendar / Gmail / Drive / Sheets / Docs by `shell_exec gws +<verb>`
// directly — no Glon dispatch hop, no schema duplication, no second copy
// of mutation safety to maintain. The "announce destructive actions
// before running them" guard is a system-prompt rule, not a wrapper.
//
// This handler exists for REPL convenience: `/google` prints the same
// cheatsheet the agent reads from its system prompt.

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m"; const BOLD = "\x1b[1m"; const CYAN = "\x1b[36m"; const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

const handler = async (_cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	print([
		bold("  Google Workspace") + dim(" — shell out to gws. No actor."),
		"",
		dim("  Auth lives in gws's OS keyring; you never see tokens."),
		"",
		dim("  Discovery:"),
		`    ${cyan("gws --help")}              ${dim("# verb groups: calendar gmail drive sheets docs")}`,
		`    ${cyan("gws +<verb> --help")}      ${dim("# args for a specific verb")}`,
		"",
		dim("  Read-only verbs:"),
		`    ${cyan("gws +calendar_agenda")}                 ${cyan("gws +calendar_list_events --range today")}`,
		`    ${cyan("gws +gmail_triage")}                    ${cyan("gws +gmail_search --query Q")}`,
		`    ${cyan("gws +gmail_read --id ID")}              ${cyan("gws +drive_search --query Q")}`,
		`    ${cyan("gws +drive_get --id ID")}               ${cyan("gws +sheets_read --id ID --range A1:Z")}`,
		`    ${cyan("gws +docs_get --id ID")}`,
		"",
		dim("  Mutating verbs (calendar_insert, calendar_delete_event,"),
		dim("  gmail_send, gmail_reply, sheets_append, docs_write):"),
		`    ${cyan("gws +<verb> ... --dry-run")}   ${dim("# safe preview, no side effects")}`,
		`    ${cyan("gws +<verb> ...")}              ${dim("# real call — describe first, run after approval")}`,
	].join("\n"));
};

const program: ProgramDef = { handler };
export default program;
