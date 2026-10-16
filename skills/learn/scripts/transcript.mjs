// Claude Code session transcripts: one JSON record per line. Unreadable lines are skipped.
// The format is internal to Claude Code and may change between releases. log-event.mjs reads
// `type`, `uuid`, `isMeta`, `isCompactSummary` and `message.content` (text and tool_use blocks),
// as written by Claude Code 2.1.x. If a field goes missing, evidence ids come out empty; nothing
// breaks.
export const parseRecords = (raw) =>
  raw.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
