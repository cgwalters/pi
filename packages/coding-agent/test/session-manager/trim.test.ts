import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
	type TrimToolResultEntry,
} from "../../src/core/session-manager.ts";

function makeToolCallMessage(toolCallId: string): SessionMessageEntry {
	return {
		type: "message",
		id: `entry-${toolCallId}-call`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "bash",
					arguments: { command: "echo hello" },
				},
			],
			provider: "test",
			model: "test-model",
			api: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
	};
}

function makeToolResultEntry(
	id: string,
	parentId: string | null,
	toolCallId: string,
	content: string,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: content }],
			isError: false,
			timestamp: Date.now(),
		},
	};
}

function makeUserEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function makeTrimToolResultEntry(
	id: string,
	parentId: string | null,
	toolCallId: string,
	summary: string,
): TrimToolResultEntry {
	return {
		type: "trim_tool_result",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		toolCallId,
		summary: [{ type: "text", text: summary }],
		source: "agent",
	};
}

describe("trim entries", () => {
	it("should replace tool result content when trim exists on path", () => {
		const entries: SessionEntry[] = [
			makeUserEntry("e1", null, "run the build"),
			makeToolCallMessage("tc1"),
			makeToolResultEntry("e2", "e1", "tc1", "50KB of build output here..."),
			makeTrimToolResultEntry("e3", "e2", "tc1", "Clean build, 0 errors"),
		];

		// Wire up parentIds
		entries[1].parentId = "e1";
		entries[2].parentId = entries[1].id;
		entries[3].parentId = "e2";

		const ctx = buildSessionContext(entries, "e3");
		const toolResult = ctx.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(toolResult!.content).toEqual([{ type: "text", text: "Clean build, 0 errors" }]);
	});

	it("should not replace tool result content when no trim exists", () => {
		const entries: SessionEntry[] = [
			makeUserEntry("e1", null, "run the build"),
			makeToolCallMessage("tc1"),
			makeToolResultEntry("e2", "e1", "tc1", "50KB of build output here..."),
		];

		entries[1].parentId = "e1";
		entries[2].parentId = entries[1].id;

		const ctx = buildSessionContext(entries, "e2");
		const toolResult = ctx.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(toolResult!.content).toEqual([{ type: "text", text: "50KB of build output here..." }]);
	});

	it("should use the last trim when multiple trims target the same tool call", () => {
		const entries: SessionEntry[] = [
			makeUserEntry("e1", null, "run the build"),
			makeToolCallMessage("tc1"),
			makeToolResultEntry("e2", "e1", "tc1", "50KB of build output here..."),
			makeTrimToolResultEntry("e3", "e2", "tc1", "First summary"),
			makeTrimToolResultEntry("e4", "e3", "tc1", "Updated summary"),
		];

		entries[1].parentId = "e1";
		entries[2].parentId = entries[1].id;
		entries[3].parentId = "e2";
		entries[4].parentId = "e3";

		const ctx = buildSessionContext(entries, "e4");
		const toolResult = ctx.messages.find((m) => m.role === "toolResult");
		expect(toolResult!.content).toEqual([{ type: "text", text: "Updated summary" }]);
	});

	it("should only apply trim on the branch that contains it", () => {
		// Branch 1: has trim
		// Branch 2: no trim (different leaf)
		const entries: SessionEntry[] = [
			makeUserEntry("e1", null, "run the build"),
			makeToolCallMessage("tc1"),
			makeToolResultEntry("e2", "e1", "tc1", "Original output"),
			makeTrimToolResultEntry("e3", "e2", "tc1", "Trimmed output"),
			// Branch 2 starts from e2
			makeUserEntry("e5", "e2", "continue without trim"),
		];

		entries[1].parentId = "e1";
		entries[2].parentId = entries[1].id;

		// Branch 1: leaf = e3 (has trim)
		const ctx1 = buildSessionContext(entries, "e3");
		const toolResult1 = ctx1.messages.find((m) => m.role === "toolResult");
		expect(toolResult1!.content).toEqual([{ type: "text", text: "Trimmed output" }]);

		// Branch 2: leaf = e5 (no trim)
		const ctx2 = buildSessionContext(entries, "e5");
		const toolResult2 = ctx2.messages.find((m) => m.role === "toolResult");
		expect(toolResult2!.content).toEqual([{ type: "text", text: "Original output" }]);
	});

	it("should trim only the targeted tool result when multiple exist", () => {
		const entries: SessionEntry[] = [
			makeUserEntry("e1", null, "two commands"),
			makeToolCallMessage("tc1"),
			makeToolResultEntry("e2", "e1", "tc1", "First output"),
			makeToolCallMessage("tc2"),
			makeToolResultEntry("e3", "e2", "tc2", "Second output"),
			makeTrimToolResultEntry("e4", "e3", "tc1", "First trimmed"),
		];

		entries[1].parentId = "e1";
		entries[2].parentId = entries[1].id;
		entries[3].parentId = "e2";
		entries[4].parentId = entries[3].id;
		entries[5].parentId = "e3";

		const ctx = buildSessionContext(entries, "e4");
		const toolResults = ctx.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0].content).toEqual([{ type: "text", text: "First trimmed" }]);
		expect(toolResults[1].content).toEqual([{ type: "text", text: "Second output" }]);
	});

	it("appendTrim persists and affects context", () => {
		const sm = SessionManager.inMemory();

		// Add a user message + tool result
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "run something" }],
			timestamp: Date.now(),
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-abc", name: "bash", arguments: { command: "ls" } }],
			provider: "test",
			model: "test",
			api: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "tc-abc",
			toolName: "bash",
			content: [{ type: "text", text: "file1.ts\nfile2.ts\nfile3.ts\n... 500 more files" }],
			isError: false,
			timestamp: Date.now(),
		});

		// Before trim
		let ctx = sm.buildSessionContext();
		let toolResult = ctx.messages.find((m) => m.role === "toolResult");
		expect(toolResult!.content[0]).toEqual({
			type: "text",
			text: "file1.ts\nfile2.ts\nfile3.ts\n... 500 more files",
		});

		// Trim it
		sm.appendTrim("tc-abc", [{ type: "text", text: "503 files listed" }], "agent");

		// After trim
		ctx = sm.buildSessionContext();
		toolResult = ctx.messages.find((m) => m.role === "toolResult");
		expect(toolResult!.content).toEqual([{ type: "text", text: "503 files listed" }]);

		// Verify trim entry exists
		const entries = sm.getEntries();
		const trimEntry = entries.find((e) => e.type === "trim_tool_result");
		expect(trimEntry).toBeDefined();
		expect((trimEntry as TrimToolResultEntry).toolCallId).toBe("tc-abc");
		expect((trimEntry as TrimToolResultEntry).source).toBe("agent");
	});
});
