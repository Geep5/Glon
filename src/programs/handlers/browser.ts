// Browser automation — shell cheatsheet for `agent-browser`.
//
// agent-browser is a Rust CLI (vercel-labs/agent-browser) that drives Chrome
// via the DevTools Protocol with a persistent local daemon. It already
// solves auth persistence (sessions, profiles, state files), accessibility-
// based element refs (`@e1`, `@e2`), batch execution, and screenshot/PDF
// export. Anything we'd wrap in a Glon program would be 90% wheel-recreation,
// so the agent talks to it via shell_exec and this program is just a REPL
// cheatsheet matching what the system prompt teaches.
//
// Install: `npm install -g agent-browser`. Existing system Chrome is
// detected automatically; running `agent-browser install` to download
// Chrome for Testing is optional.

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m"; const BOLD = "\x1b[1m"; const CYAN = "\x1b[36m"; const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

const handler = async (_cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	print([
		bold("  Browser automation") + dim(" — drive Chrome from shell. No actor."),
		"",
		dim("  CLI: agent-browser (Rust). doctor: agent-browser doctor"),
		dim("  Each agent should pin --session <name> so state persists across calls."),
		"",
		dim("  Standard AI flow (snapshot → @e refs → action):"),
		`    ${cyan("agent-browser --session <name> open <URL>")}`,
		`    ${cyan("agent-browser --session <name> snapshot")}     ${dim("# tree with @e1, @e2 refs")}`,
		`    ${cyan("agent-browser --session <name> click @e3")}`,
		`    ${cyan("agent-browser --session <name> fill @e5 \"value\"")}`,
		`    ${cyan("agent-browser --session <name> screenshot /tmp/r.png")}`,
		`    ${cyan("agent-browser --session <name> close")}        ${dim("# only when truly done")}`,
		"",
		dim("  Multi-step bundle (avoid per-command daemon round-trip):"),
		`    ${cyan("agent-browser --session <name> batch \\")}`,
		`    ${cyan("  \"open <URL>\" \"snapshot\" \"click @e1\" \"screenshot /tmp/r.png\"")}`,
		"",
		dim("  Auth shortcut — import the principal's live Chrome login:"),
		`    ${cyan("agent-browser --auto-connect state save /tmp/auth.json")}`,
		`    ${cyan("agent-browser --session <name> --state /tmp/auth.json open <URL>")}`,
		"",
		dim("  Full reference: agent-browser --help, agent-browser <cmd> --help"),
		dim("  Project: https://github.com/vercel-labs/agent-browser"),
	].join("\n"));
};

const program: ProgramDef = { handler };
export default program;
