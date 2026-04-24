/**
 * Demo script for AI chat in Glon OS
 *
 * Shows how to create an agent and interact with it.
 */

import { createClient } from "rivetkit/client";
import type { app } from "./src/index.js";
import { stringVal } from "./src/proto.js";

const ENDPOINT = process.env.GLON_ENDPOINT ?? "http://localhost:6420";

async function main() {
	console.log("🤖 Glon OS AI Chat Demo");
	console.log("========================\n");

	const client = createClient<typeof app>(ENDPOINT);
	const store = client.storeActor.getOrCreate(["root"]);

	// Create an AI agent
	const agentName = "DemoAI";
	console.log(`Creating AI agent: ${agentName}...`);

	const agentId = await store.create("agent", JSON.stringify({
		name: stringVal(agentName),
		model: stringVal("claude-3-5-sonnet"),
		systemPrompt: stringVal("You are a helpful AI assistant running inside Glon OS, a content-addressed DAG-based operating system. Be friendly and informative!"),
		temperature: stringVal("0.7"),
	}));

	console.log(`✅ Agent created: ${agentId.slice(0, 12)}...\n`);

	// Get the agent actor
	const agentActor = client.agentActor.getOrCreate([agentId]);

	// Send some messages
	const questions = [
		"Hello! Can you tell me about yourself?",
		"What is Glon OS and what makes it special?",
		"How does the content-addressed DAG work?"
	];

	for (const question of questions) {
		console.log(`👤 User: ${question}`);

		const response = await agentActor.chat(question);
		console.log(`🤖 ${agentName}: ${response}\n`);

		// Small delay between questions
		await new Promise(r => setTimeout(r, 1000));
	}

	// Show conversation history
	console.log("📜 Conversation History:");
	console.log("========================");
	const history = await agentActor.getHistory();

	for (const msg of history) {
		const role = msg.role === "user" ? "👤" : "🤖";
		const preview = msg.content.length > 100
			? msg.content.slice(0, 100) + "..."
			: msg.content;
		console.log(`${role} ${msg.role}: ${preview}`);
	}

	console.log("\n✨ Demo complete!");
	process.exit(0);
}

main().catch(err => {
	console.error("❌ Error:", err);
	process.exit(1);
});