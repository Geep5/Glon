/**
 * Tic-Tac-Toe — a program that runs on Glon OS.
 *
 * The board is a regular object. Nine cell fields, a turn field,
 * a status field. Every move is a Change in the DAG. The game
 * logic validates and applies moves through the standard protocol.
 *
 * This is what "a program on the OS" looks like: pure logic
 * operating on protobuf objects through the Change DAG. No special
 * actor types, no framework hooks. Just a protocol consumer.
 */

import { stringVal, displayValue } from "../proto.js";
import type { Value, Change } from "../proto.js";
import { hexEncode } from "../crypto.js";
import { readChangeByHex, listChangeFiles } from "../disk.js";

// ── Board model ─────────────────────────────────────────────────

export type Cell = "X" | "O" | "";
export type Player = "X" | "O";
export type Status = "playing" | "X_wins" | "O_wins" | "draw";

export interface BoardState {
	cells: Cell[];       // 9 cells, index 0-8
	turn: Player;
	status: Status;
	moveCount: number;
}

const WIN_LINES = [
	[0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
	[0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
	[0, 4, 8], [2, 4, 6],             // diagonals
];

// ── Read board from object fields ───────────────────────────────

/** Extract a BoardState from an object's fields Record. */
export function readBoard(fields: Record<string, any>): BoardState {
	const cells: Cell[] = [];
	for (let i = 0; i < 9; i++) {
		const v = fields[`cell_${i}`];
		const raw = extractString(v);
		cells.push((raw === "X" || raw === "O") ? raw : "");
	}
	const turn = extractString(fields["turn"]) as Player || "X";
	const statusRaw = extractString(fields["status"]);
	const status: Status = (statusRaw === "X_wins" || statusRaw === "O_wins" || statusRaw === "draw")
		? statusRaw : "playing";
	const moveCount = cells.filter(c => c !== "").length;
	return { cells, turn, status, moveCount };
}

/** Pull a string out of a Value-like object (handles Rivet serialization shapes). */
function extractString(v: unknown): string {
	if (!v) return "";
	if (typeof v === "string") return v;
	if (typeof v === "object" && v !== null) {
		const obj = v as Record<string, unknown>;
		if (typeof obj["stringValue"] === "string") return obj["stringValue"];
	}
	return "";
}

// ── Move validation ─────────────────────────────────────────────

export interface MoveResult {
	ok: boolean;
	error?: string;
	fields: Record<string, Value>;  // FieldSet values to apply
	newStatus: Status;
}

/** Validate and compute the fields for a move. Does NOT write anything. */
export function computeMove(board: BoardState, position: number, player?: Player): MoveResult {
	if (board.status !== "playing") {
		return { ok: false, error: `game over: ${board.status}`, fields: {}, newStatus: board.status };
	}
	if (position < 0 || position > 8) {
		return { ok: false, error: `invalid position: ${position} (use 0-8)`, fields: {}, newStatus: "playing" };
	}
	if (board.cells[position] !== "") {
		return { ok: false, error: `cell ${position} already taken by ${board.cells[position]}`, fields: {}, newStatus: "playing" };
	}

	const who = player ?? board.turn;
	if (who !== board.turn) {
		return { ok: false, error: `not ${who}'s turn (current: ${board.turn})`, fields: {}, newStatus: "playing" };
	}

	// Apply the move to a copy.
	const newCells = [...board.cells];
	newCells[position] = who;

	// Check for win.
	let winner: Player | null = null;
	for (const [a, b, c] of WIN_LINES) {
		if (newCells[a] && newCells[a] === newCells[b] && newCells[b] === newCells[c]) {
			winner = newCells[a] as Player;
			break;
		}
	}

	// Check for draw.
	const filled = newCells.filter(c => c !== "").length;
	const isDraw = !winner && filled === 9;

	const newStatus: Status = winner ? `${winner}_wins` : isDraw ? "draw" : "playing";
	const nextTurn: Player = who === "X" ? "O" : "X";

	// Build the field updates as a single Change.
	const fields: Record<string, Value> = {
		[`cell_${position}`]: stringVal(who),
		turn: stringVal(newStatus === "playing" ? nextTurn : who),
		status: stringVal(newStatus),
	};
	if (winner) {
		fields["winner"] = stringVal(winner);
	}

	return { ok: true, fields, newStatus };
}

// ── Board rendering ─────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function cellDisplay(cell: Cell, index: number): string {
	if (cell === "X") return `${CYAN}${BOLD} X ${RESET}`;
	if (cell === "O") return `${RED}${BOLD} O ${RESET}`;
	return `${DIM} ${index} ${RESET}`;
}

export function renderBoard(board: BoardState): string {
	const c = board.cells;
	const lines = [
		"",
		`  ${cellDisplay(c[0], 0)}│${cellDisplay(c[1], 1)}│${cellDisplay(c[2], 2)}`,
		`  ${DIM}───┼───┼───${RESET}`,
		`  ${cellDisplay(c[3], 3)}│${cellDisplay(c[4], 4)}│${cellDisplay(c[5], 5)}`,
		`  ${DIM}───┼───┼───${RESET}`,
		`  ${cellDisplay(c[6], 6)}│${cellDisplay(c[7], 7)}│${cellDisplay(c[8], 8)}`,
		"",
	];

	if (board.status === "playing") {
		lines.push(`  ${BOLD}${board.turn}${RESET}'s turn  ${DIM}(move ${board.moveCount + 1})${RESET}`);
	} else if (board.status === "draw") {
		lines.push(`  ${YELLOW}${BOLD}Draw!${RESET}`);
	} else {
		const winner = board.status === "X_wins" ? "X" : "O";
		const color = winner === "X" ? CYAN : RED;
		lines.push(`  ${color}${BOLD}${winner} wins!${RESET}  ${DIM}(${board.moveCount} moves)${RESET}`);
	}

	return lines.join("\n");
}

// ── Move history rendering ──────────────────────────────────────

export function renderMoveHistory(objectId: string): string {
	const allHex = listChangeFiles();
	const changes: Change[] = [];
	for (const hexId of allHex) {
		const c = readChangeByHex(hexId);
		if (c && c.objectId === objectId) changes.push(c);
	}
	changes.sort((a, b) => a.timestamp - b.timestamp);

	const lines: string[] = [];
	let moveNum = 0;

	for (const c of changes) {
		const hex = hexEncode(c.id).slice(0, 12);
		const ts = new Date(c.timestamp).toISOString().slice(11, 19);

		for (const op of c.ops) {
			if (op.objectCreate) {
				lines.push(`  ${DIM}${hex}${RESET}  ${DIM}${ts}${RESET}  ${GREEN}new game${RESET}`);
			} else if (op.fieldSet) {
				const key = op.fieldSet.key;
				const val = extractString(op.fieldSet.value);

				// Only show cell moves, not turn/status updates.
				if (key.startsWith("cell_") && (val === "X" || val === "O")) {
					moveNum++;
					const pos = key.slice(5);
					const color = val === "X" ? CYAN : RED;
					lines.push(`  ${DIM}${hex}${RESET}  ${DIM}${ts}${RESET}  ${BOLD}#${moveNum}${RESET} ${color}${val}${RESET} → position ${pos}`);
				} else if (key === "status" && val !== "playing") {
					const label = val === "draw" ? `${YELLOW}draw${RESET}` :
						val === "X_wins" ? `${CYAN}${BOLD}X wins${RESET}` :
						`${RED}${BOLD}O wins${RESET}`;
					lines.push(`  ${DIM}${hex}${RESET}  ${DIM}${ts}${RESET}  ${label}`);
				}
			}
		}
	}

	if (lines.length === 0) return `  ${DIM}(no moves)${RESET}`;
	return lines.join("\n");
}

// ── Initial fields for a new game ───────────────────────────────

export function newGameFields(): Record<string, Value> {
	const fields: Record<string, Value> = {
		turn: stringVal("X"),
		status: stringVal("playing"),
	};
	for (let i = 0; i < 9; i++) {
		fields[`cell_${i}`] = stringVal("");
	}
	return fields;
}
