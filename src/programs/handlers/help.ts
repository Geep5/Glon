/**
 * Help program — dynamically lists all available programs.
 *
 * This used to be the only built-in command in the shell. Now it's
 * just another program that queries the store for all programs and
 * displays them. The shell has ZERO built-in commands.
 */

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }

async function showHelp(ctx: ProgramContext): Promise<void> {
	// Get all programs from the store
	const refs = await ctx.store.list("program");

	if (refs.length === 0) {
		ctx.print("No programs found!");
		ctx.print(dim("Run 'npm run bootstrap' to seed the initial programs."));
		return;
	}

	ctx.print(bold("Available programs:"));
	ctx.print("");

	// Load and display each program
	for (const ref of refs) {
		const obj = await ctx.store.get(ref.id);
		if (!obj?.fields) continue;

		const name = obj.fields.name?.stringValue || "Unnamed";
		const prefix = obj.fields.prefix?.stringValue;
		if (!prefix) continue;

		ctx.print(cyan(prefix.padEnd(14)) + name);

		// Show commands if available
		const commands = obj.fields.commands?.mapValue?.entries;
		if (commands && Object.keys(commands).length > 0) {
			for (const [cmd, desc] of Object.entries(commands)) {
				const description = desc?.stringValue || "";
				ctx.print("  " + dim(cmd.padEnd(12)) + description);
			}
		}
	}

	ctx.print("");
	ctx.print(dim("Type a program prefix to see its commands."));
	ctx.print(dim("Example: /crud create page MyPage"));
}

const programDef: ProgramDef = {
	handler: async (cmd: string, _args: string[], ctx: ProgramContext) => {
		// Any subcommand shows help
		await showHelp(ctx);
	},
};

export default programDef;