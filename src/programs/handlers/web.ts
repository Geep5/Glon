// Web — shell cheatsheet, not a wrapper.
//
// HTTP from agents goes through shell_exec curl. There's nothing
// agent-specific about an HTTP request that justifies a dedicated Glon
// program in front of it; the SSRF / body-cap / timeout policy that the
// old actor enforced is now an instruction in the system prompt and a
// matter of disciplined shell composition.
//
// This handler exists so a human at the REPL can `/ web` and see the
// recipes — same content the agent reads from its system prompt.

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m"; const BOLD = "\x1b[1m"; const CYAN = "\x1b[36m"; const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

const handler = async (_cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	print([
		bold("  Web") + dim(" — talk to the internet from shell. No actor."),
		"",
		dim("  On PATH: curl, jq, pandoc, html2text, lynx."),
		"",
		dim("  Recipes (run via shell_exec):"),
		`    ${cyan("curl -s URL | jq .")}                    ${dim("# JSON")}`,
		`    ${cyan("curl -sL URL | pandoc -f html -t plain")}${dim("  # HTML → readable")}`,
		`    ${cyan("curl -sLI URL")}                          ${dim("# HEAD: status + headers, no body")}`,
		`    ${cyan("curl -sL URL > /tmp/p && wc -c /tmp/p")} ${dim("  # bound body before reading")}`,
		"",
		dim("  Cite URL + status in any report. If body truncated, surface bytes."),
		dim("  Don't probe localhost / private IPs unless explicitly asked."),
	].join("\n"));
};

const program: ProgramDef = { handler };
export default program;
