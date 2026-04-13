// Agent — an LLM-powered conversational agent that runs on Glon OS.
//
// Each agent is a regular Glon object (type "agent"). Conversation turns
// are stored as blocks in the DAG — every prompt and response is a
// content-addressed Change. The full conversation history is replayable
// from genesis. Agent-to-agent messaging works through the same block
// mechanism: one agent reads another's DAG to build context.
//
// LLM calls are I/O side effects in the handler. The DAG stores results,
// not the calls themselves — preserving "any peer can recompute state
// from changes alone."

import type { ProgramDef, ProgramContext } from "../runtime.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function magenta(s: string) { return `${MAGENTA}${s}${RESET}`; }

// ── Helpers ──────────────────────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

/** Build a sorted list of conversation turns from an agent object's blocks. */
function extractTurns(blocks: any[], provenance: any): Turn[] {
	const turns: Turn[] = [];
	for (const block of blocks) {
		const text = block.content?.text?.text;
		if (text === undefined || text === null) continue;

		const prov = provenance[block.id];
		const timestamp = prov?.timestamp ?? 0;

		// Convention: block style 0 = user, style 1 = assistant
		const role: "user" | "assistant" = block.content?.text?.style === 1 ? "assistant" : "user";
		turns.push({ role, content: text, timestamp });
	}
	turns.sort((a, b) => a.timestamp - b.timestamp);
	return turns;
}

interface Turn {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

// ── LLM API ──────────────────────────────────────────────────────

interface InferenceResult {
	content: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
}

/**
 * Call the Anthropic Messages API with streaming support.
 * API key from ANTHROPIC_API_KEY env var.
 */
async function callAnthropic(
	messages: { role: string; content: string }[],
	system: string | undefined,
	model: string,
	temperature?: number,
	onChunk?: (text: string) => void,
): Promise<InferenceResult> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

	const body: any = {
		model,
		max_tokens: 4096,
		messages,
		stream: !!onChunk,
		temperature: temperature ?? 0.7,
	};
	if (system) body.system = system;

	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Anthropic API ${res.status}: ${text}`);
	}

	// Handle streaming response
	if (onChunk) {
		let content = "";
		let inputTokens = 0;
		let outputTokens = 0;

		const decoder = new TextDecoder();
		const reader = res.body!.getReader();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split('\n');

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') continue;

					try {
						const parsed = JSON.parse(data);

						if (parsed.type === 'content_block_delta') {
							const text = parsed.delta?.text;
							if (text) {
								content += text;
								onChunk(text);
							}
						} else if (parsed.type === 'message_start') {
							inputTokens = parsed.message?.usage?.input_tokens ?? 0;
						} else if (parsed.type === 'message_delta') {
							outputTokens = parsed.usage?.output_tokens ?? 0;
						}
					} catch (e) {
						// Ignore parse errors
					}
				}
			}
		}

		return { content, model, inputTokens, outputTokens };
	}

	// Non-streaming response
	const data = await res.json() as any;
	const content = data.content?.[0]?.text ?? "";
	return {
		content,
		model: data.model ?? model,
		inputTokens: data.usage?.input_tokens ?? 0,
		outputTokens: data.usage?.output_tokens ?? 0,
	};
}

// ── Command handler ──────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { client, store, resolveId, stringVal, print, randomUUID } = ctx as any;

	switch (cmd) {
		// /agent new [name] [--model X] [--system "prompt"]
		case "new": {
			let name = "agent";
			let model = DEFAULT_MODEL;
			let system: string | undefined;

			// Simple arg parsing: positional name, then --flags
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--model" && args[i + 1]) { model = args[++i]; }
				else if (args[i] === "--system" && args[i + 1]) { system = args[++i]; }
				else { positional.push(args[i]); }
			}
			if (positional.length > 0) name = positional.join(" ");

			const fields: Record<string, any> = {
				name: stringVal(name),
				model: stringVal(model),
			};
			if (system) fields.system = stringVal(system);

			const id = await store.create("agent", JSON.stringify(fields));
			print(green("Agent created: ") + bold(id));
			print(dim(`  model: ${model}`));
			if (system) print(dim(`  system: ${system}`));
			print(dim(`  agent ask ${id.slice(0, 8)} Hello!`));
			break;
		}

		// /agent ask <id> <prompt...>
		case "ask": {
			const raw = args[0];
			const prompt = args.slice(1).join(" ");
			if (!raw || !prompt) { print(red("Usage: agent ask <id> <prompt...>")); break; }

			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			// Read current state to build conversation history
			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }

			const system = extractString(state.fields["system"]);
			const model = extractString(state.fields["model"]) || DEFAULT_MODEL;
			const turns = extractTurns(state.blocks, state.blockProvenance);

			// Build messages for the API
			const messages = turns.map((t: Turn) => ({ role: t.role, content: t.content }));
			messages.push({ role: "user", content: prompt });

			// Store the user message as a block first
			const actor = client.objectActor.getOrCreate([id]);
			const userBlockId = randomUUID();
			await actor.addBlock(JSON.stringify({
				id: userBlockId,
				childrenIds: [],
				content: { text: { text: prompt, style: 0 } }, // style 0 = user
			}));

			// Get temperature setting if configured
			const temperature = extractString(state.fields["temperature"]);
			const temp = temperature ? parseFloat(temperature) : undefined;

			// Call the LLM with streaming
			print(dim(`  thinking (${model})...`));
			print("");
			print(magenta(bold("  assistant")) + dim(" streaming..."));
			print("");

			let streamedContent = "";
			let lineBuffer = "";
			const onChunk = (text: string) => {
				streamedContent += text;
				lineBuffer += text;

				// Print complete lines as they arrive
				const lines = lineBuffer.split("\n");
				for (let i = 0; i < lines.length - 1; i++) {
					print(`  ${lines[i]}`);
				}
				lineBuffer = lines[lines.length - 1];
			};

			let result: InferenceResult;
			try {
				result = await callAnthropic(messages, system, model, temp, onChunk);
				// Print any remaining partial line
				if (lineBuffer) {
					print(`  ${lineBuffer}`);
				}
			} catch (err: any) {
				print(red("  Error: ") + err.message);
				break;
			}

			// Store the response as a block
			const assistantBlockId = randomUUID();
			await actor.addBlock(JSON.stringify({
				id: assistantBlockId,
				childrenIds: [],
				content: { text: { text: result.content, style: 1 } }, // style 1 = assistant
			}));

			// Print token usage
			print("");
			print(dim(`  (${result.inputTokens} input + ${result.outputTokens} output = ${result.inputTokens + result.outputTokens} total tokens)`));
			print("");
			break;
		}

		// /agent history <id>
		case "history": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent history <id>")); break; }

			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }

			const name = extractString(state.fields["name"]) || "agent";
			const model = extractString(state.fields["model"]) || DEFAULT_MODEL;
			const system = extractString(state.fields["system"]);
			const turns = extractTurns(state.blocks, state.blockProvenance);

			print(bold(`  ${name}`) + dim(` (${model})`));
			if (system) print(dim(`  system: ${system}`));
			print("");

			if (turns.length === 0) {
				print(dim("  (no conversation yet)"));
				break;
			}

			for (const turn of turns) {
				const ts = turn.timestamp
					? new Date(turn.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
					: "--:--";
				const label = turn.role === "user"
					? cyan(bold("  user"))
					: magenta(bold("  assistant"));
				print(`${label} ${dim(ts)}`);
				for (const line of turn.content.split("\n")) {
					print(`    ${line}`);
				}
				print("");
			}
			break;
		}

		// /agent config <id> <key> <value>
		case "config": {
			const raw = args[0];
			const key = args[1];
			const value = args.slice(2).join(" ");
			if (!raw || !key || !value) {
				print(red("Usage: agent config <id> <key> <value>"));
				print(dim("  Keys: model, system, name, temperature"));
				break;
			}

			const allowed = ["model", "system", "name", "temperature"];
			if (!allowed.includes(key)) {
				print(red(`Unknown config key: ${key}. Use: ${allowed.join(", ")}`));
				break;
			}

			// Validate temperature value if specified
			if (key === "temperature") {
				const temp = parseFloat(value);
				if (isNaN(temp) || temp < 0 || temp > 2) {
					print(red("Temperature must be a number between 0 and 2"));
					break;
				}
			}

			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			const actor = client.objectActor.getOrCreate([id]);
			await actor.setField(key, JSON.stringify(stringVal(value)));
			print(dim(`  ${key} = `) + value);
			break;
		}

		// /agent read <id> — peek at another agent's conversation (context sharing)
		case "read": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent read <id>")); break; }

			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }

			const name = extractString(state.fields["name"]) || "agent";
			const turns = extractTurns(state.blocks, state.blockProvenance);

			print(bold(`  ${name}`) + dim(` — ${turns.length} turns`));
			print("");

			// Show last 5 turns as a summary
			const recent = turns.slice(-5);
			if (turns.length > 5) print(dim(`  ... ${turns.length - 5} earlier turns`));
			for (const turn of recent) {
				const label = turn.role === "user" ? cyan("user") : magenta("assistant");
				const preview = turn.content.length > 120
					? turn.content.slice(0, 120) + "..."
					: turn.content;
				print(`  ${label}: ${preview}`);
			}
			break;
		}

		// /agent inject <target> <source> — inject another agent's context
		case "inject": {
			const targetRaw = args[0];
			const sourceRaw = args[1];
			if (!targetRaw || !sourceRaw) {
				print(red("Usage: agent inject <target-id> <source-id>"));
				print(dim("  Adds source agent's conversation as context to target's next prompt"));
				break;
			}

			const targetId = await resolveId(targetRaw);
			const sourceId = await resolveId(sourceRaw);
			if (!targetId) { print(red("Target not found: ") + targetRaw); break; }
			if (!sourceId) { print(red("Source not found: ") + sourceRaw); break; }

			// Read the source agent's conversation
			const sourceState = await store.get(sourceId);
			if (!sourceState) { print(red("Source agent not found")); break; }

			const sourceName = extractString(sourceState.fields["name"]) || "agent";
			const sourceTurns = extractTurns(sourceState.blocks, sourceState.blockProvenance);

			if (sourceTurns.length === 0) {
				print(dim("  Source agent has no conversation to inject"));
				break;
			}

			// Format the source conversation as a context block on the target
			const contextLines = [`[Context from agent "${sourceName}" (${sourceId.slice(0, 8)})]`];
			for (const turn of sourceTurns) {
				contextLines.push(`${turn.role}: ${turn.content}`);
			}
			contextLines.push("[End context]");

			const actor = client.objectActor.getOrCreate([targetId]);
			const blockId = randomUUID();
			await actor.addBlock(JSON.stringify({
				id: blockId,
				childrenIds: [],
				content: { text: { text: contextLines.join("\n"), style: 0 } },
			}));

			print(green(`  Injected ${sourceTurns.length} turns from "${sourceName}" into target`));
			print(dim(`  block ${blockId.slice(0, 8)}`));
			break;
		}

		default: {
			print([
				bold("  Agent"),
				`    ${cyan("agent new")} ${dim("[name] [--model X] [--system \"...\"]")}  create an agent`,
				`    ${cyan("agent ask")} ${dim("<id> <prompt...>")}                      chat with agent`,
				`    ${cyan("agent history")} ${dim("<id>")}                               conversation history`,
				`    ${cyan("agent config")} ${dim("<id> <key> <value>")}                  set model/system/name`,
				`    ${cyan("agent read")} ${dim("<id>")}                                  peek at agent's conversation`,
				`    ${cyan("agent inject")} ${dim("<target> <source>")}                   inject context from another agent`,
				"",
				dim("  Models: claude-sonnet-4-20250514, claude-haiku-4-20250414, etc."),
				dim("  Requires ANTHROPIC_API_KEY env var."),
			].join("\n"));
		}
	}
};

const program: ProgramDef = { handler };
export default program;
