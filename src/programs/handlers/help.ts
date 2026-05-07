/**
 * Help program — dynamically lists all available programs.
 *
 * This used to be the only built-in command in the shell. Now it's
 * just another program that queries the store for all programs and
 * displays them. The shell has ZERO built-in commands.
 */

import type { ProgramDef, ProgramContext } from "../runtime.js";
import { dim, bold, cyan, green } from "../shared.js";


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