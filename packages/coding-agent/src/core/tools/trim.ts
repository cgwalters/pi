import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";

const trimSchema = Type.Object({
	summary: Type.String({
		description: "Concise summary to replace the original output. Preserve key facts, errors, and warnings.",
	}),
	offset: Type.Optional(
		Type.Number({
			description:
				"Which tool result to trim, counting back from the most recent. " +
				"0 (default) = last tool result, 1 = second-to-last, etc. " +
				"Skips trim_tool_result results and already-trimmed results.",
			default: 0,
		}),
	),
});

export type TrimToolInput = Static<typeof trimSchema>;

export interface TrimToolDetails {
	toolCallId: string;
	toolName: string;
	originalBytes: number;
}

export function createTrimToolDefinition(
	getSessionManager: () => SessionManager,
	onTrimmed?: (toolCallId: string, summary: TextContent[]) => void,
): ToolDefinition<typeof trimSchema, TrimToolDetails> {
	return {
		name: "trim_tool_result",
		label: "Trim Result",
		description:
			"Replace a previous tool result with a concise summary to reduce context token usage. " +
			"Use after large tool outputs (build logs, file listings, command output) that are no longer needed in full. " +
			"By default trims the most recent tool result. Use offset to target older results.",
		promptSnippet: "Replace a large tool result with a short summary to save context tokens",
		promptGuidelines: [
			"After receiving a large tool result (roughly over 2KB) that you do not need to reference in full later, " +
				"call trim_tool_result to compress it. Do not trim results you still need to quote precisely.",
		],
		parameters: trimSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { summary, offset = 0 } = params;
			const sm = getSessionManager();

			// Find trimmable tool results on the current branch, skipping
			// trim_tool_result results and already-trimmed results.
			const branch = ctx.sessionManager.getBranch();
			const alreadyTrimmed = new Set<string>();
			for (const entry of branch) {
				if (entry.type === "trim_tool_result") {
					alreadyTrimmed.add(entry.toolCallId);
				}
			}

			const candidates: Array<{ toolCallId: string; toolName: string; bytes: number }> = [];
			for (const entry of branch) {
				if (entry.type !== "message") continue;
				if (entry.message.role !== "toolResult") continue;
				if (entry.message.toolName === "trim_tool_result") continue;
				if (alreadyTrimmed.has(entry.message.toolCallId)) continue;

				let bytes = 0;
				for (const part of entry.message.content) {
					if (part.type === "text") {
						bytes += Buffer.byteLength(part.text, "utf8");
					}
				}
				candidates.push({
					toolCallId: entry.message.toolCallId,
					toolName: entry.message.toolName ?? "unknown",
					bytes,
				});
			}

			// Reverse so index 0 = most recent
			candidates.reverse();

			if (offset < 0 || offset >= candidates.length) {
				throw new Error(
					`Offset ${offset} out of range. There are ${candidates.length} trimmable tool result(s) (0-indexed from most recent).`,
				);
			}

			const target = candidates[offset];
			const summaryContent: TextContent[] = [{ type: "text", text: summary }];
			const summaryBytes = Buffer.byteLength(summary, "utf8");

			sm.appendTrim(target.toolCallId, summaryContent, "agent");
			onTrimmed?.(target.toolCallId, summaryContent);

			const saved = target.bytes - summaryBytes;
			return {
				content: [
					{
						type: "text",
						text: `Trimmed ${target.toolName} result: ${target.bytes} -> ${summaryBytes} bytes (saved ${saved} bytes)`,
					},
				],
				details: {
					toolCallId: target.toolCallId,
					toolName: target.toolName,
					originalBytes: target.bytes,
				},
			};
		},
	};
}
