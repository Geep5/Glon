/**
 * /web program tests.
 *
 * Covers the pure helpers (guardUrl, clamp functions) and the actor
 * actions via globalThis.__WEB_FETCH mocking. No real network hits.
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import webProgram, { __test } from "../src/programs/handlers/web.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

function clearMock() { delete (globalThis as any).__WEB_FETCH; }

function minimalCtx(): ProgramContext {
	return {
		client: {}, store: {},
		resolveId: async () => null,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => "uuid",
		state: {},
		emit: () => {},
		programId: "test-web",
		objectActor: () => ({}),
		dispatchProgram: async () => undefined,
	};
}

// ── guardUrl ─────────────────────────────────────────────────────

describe("guardUrl (SSRF guard)", () => {
	it("accepts http + https", () => {
		assert.doesNotThrow(() => __test.guardUrl("http://example.com", false));
		assert.doesNotThrow(() => __test.guardUrl("https://example.com/path?x=1", false));
	});

	it("rejects file:// and data:// protocols", () => {
		assert.throws(() => __test.guardUrl("file:///etc/passwd", false), /blocked protocol/);
		assert.throws(() => __test.guardUrl("data:text/plain,hi", false), /blocked protocol/);
		assert.throws(() => __test.guardUrl("javascript:alert(1)", false), /blocked protocol/);
	});

	it("rejects other schemes outright", () => {
		assert.throws(() => __test.guardUrl("ftp://example.com", false), /only http\/https/);
	});

	it("rejects private/internal hosts by default", () => {
		const privates = [
			"http://localhost/",
			"http://127.0.0.1/",
			"http://10.0.0.5/",
			"http://192.168.1.1/",
			"http://172.16.0.1/",
			"http://169.254.169.254/",
			"http://[::1]/",
		];
		for (const u of privates) {
			assert.throws(() => __test.guardUrl(u, false), /private\/internal/, `should block ${u}`);
		}
	});

	it("allows private hosts when allow_internal=true", () => {
		assert.doesNotThrow(() => __test.guardUrl("http://127.0.0.1:6420/", true));
		assert.doesNotThrow(() => __test.guardUrl("http://localhost:6430/", true));
	});

	it("rejects garbage urls", () => {
		assert.throws(() => __test.guardUrl("not a url", false), /invalid URL/);
	});
});

// ── clamps ───────────────────────────────────────────────────────

describe("clamp helpers", () => {
	it("clampMaxBytes defaults, clamps up to 1MB", () => {
		assert.equal(__test.clampMaxBytes(undefined), 16384);
		assert.equal(__test.clampMaxBytes(0), 16384);
		assert.equal(__test.clampMaxBytes(-5), 16384);
		assert.equal(__test.clampMaxBytes(8000), 8000);
		assert.equal(__test.clampMaxBytes(5_000_000), 1_048_576);
	});

	it("clampTimeoutMs defaults, clamps up to 120s", () => {
		assert.equal(__test.clampTimeoutMs(undefined), 30_000);
		assert.equal(__test.clampTimeoutMs(5_000), 5_000);
		assert.equal(__test.clampTimeoutMs(9_999_999), 120_000);
	});
});

// ── actor actions via mock ───────────────────────────────────────

describe("/web actor actions", () => {
	afterEach(clearMock);

	it("fetch round-trips via mock", async () => {
		(globalThis as any).__WEB_FETCH = async (req: any) => ({
			status: 200,
			status_text: "OK",
			headers: { "content-type": "text/html" },
			body: `<html>you fetched ${req.url}</html>`,
			bytes: 40,
			truncated: false,
			url_fetched: req.url,
		});
		const fetchFn = webProgram.actor!.actions!.fetch;
		const res = await fetchFn(minimalCtx(), { url: "https://example.com/" }) as any;
		assert.equal(res.status, 200);
		assert.match(res.body, /example\.com/);
	});

	it("get_text returns decoded body", async () => {
		(globalThis as any).__WEB_FETCH = async () => ({
			status: 200, status_text: "OK", headers: {},
			body: "hello world", bytes: 11, truncated: false,
			url_fetched: "https://x/",
		});
		const get_text = webProgram.actor!.actions!.get_text;
		const res = await get_text(minimalCtx(), { url: "https://x/" }) as any;
		assert.equal(res.text, "hello world");
		assert.equal(res.bytes, 11);
	});

	it("get_json parses JSON responses", async () => {
		(globalThis as any).__WEB_FETCH = async () => ({
			status: 200, status_text: "OK", headers: {},
			body: '{"ok":true,"count":42}', bytes: 22, truncated: false,
			url_fetched: "https://api/x",
		});
		const get_json = webProgram.actor!.actions!.get_json;
		const res = await get_json(minimalCtx(), { url: "https://api/x" }) as any;
		assert.deepEqual(res.json, { ok: true, count: 42 });
		assert.equal(res.parse_error, undefined);
	});

	it("get_json surfaces parse errors without throwing", async () => {
		(globalThis as any).__WEB_FETCH = async () => ({
			status: 200, status_text: "OK", headers: {},
			body: "<html>not json</html>", bytes: 21, truncated: false,
			url_fetched: "https://x/",
		});
		const get_json = webProgram.actor!.actions!.get_json;
		const res = await get_json(minimalCtx(), { url: "https://x/" }) as any;
		assert.ok(res.parse_error);
	});

	it("fetch rejects private hosts without allow_internal", async () => {
		// No mock — real guardUrl fires before fetch.
		const fetchFn = webProgram.actor!.actions!.fetch;
		await assert.rejects(
			() => fetchFn(minimalCtx(), { url: "http://127.0.0.1:6420/" }),
			/private\/internal/,
		);
	});

	it("fetch allows private hosts with allow_internal=true", async () => {
		(globalThis as any).__WEB_FETCH = async (req: any) => ({
			status: 200, status_text: "OK", headers: {},
			body: "local", bytes: 5, truncated: false,
			url_fetched: req.url,
		});
		const fetchFn = webProgram.actor!.actions!.fetch;
		const res = await fetchFn(minimalCtx(), { url: "http://127.0.0.1/", allow_internal: true }) as any;
		assert.equal(res.status, 200);
	});

	it("fetch rejects missing url", async () => {
		const fetchFn = webProgram.actor!.actions!.fetch;
		await assert.rejects(() => fetchFn(minimalCtx(), {}), /url required/);
	});
});

// ── body truncation path (integration with a minimal mock Response) ───

describe("readBodyWithCap", () => {
	it("truncates at maxBytes", async () => {
		const big = "x".repeat(5000);
		const encoder = new TextEncoder();
		const bytes = encoder.encode(big);
		const stream = new ReadableStream({
			start(c) { c.enqueue(bytes); c.close(); },
		});
		const res = new Response(stream);
		const { text, bytes: got, truncated } = await __test.readBodyWithCap(res, 1024);
		assert.equal(got, 1024);
		assert.equal(text.length, 1024);
		assert.equal(truncated, true);
	});

	it("returns full body when under cap", async () => {
		const msg = "hello";
		const stream = new ReadableStream({
			start(c) { c.enqueue(new TextEncoder().encode(msg)); c.close(); },
		});
		const res = new Response(stream);
		const { text, bytes, truncated } = await __test.readBodyWithCap(res, 100);
		assert.equal(text, "hello");
		assert.equal(bytes, 5);
		assert.equal(truncated, false);
	});
});
