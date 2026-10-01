import { DatabaseSync } from "node:sqlite";

export function createDemo(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, repository TEXT, branch TEXT,
        cwd TEXT, host_type TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
        user_message TEXT, assistant_response TEXT, timestamp TEXT);
      CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, session_id TEXT, checkpoint_number INTEGER,
        title TEXT, overview TEXT, history TEXT, work_done TEXT, technical_details TEXT,
        important_files TEXT, next_steps TEXT, created_at TEXT);
      CREATE TABLE session_files (id INTEGER PRIMARY KEY, session_id TEXT, file_path TEXT,
        tool_name TEXT, first_seen_at TEXT);
      CREATE TABLE session_refs (id INTEGER PRIMARY KEY, session_id TEXT, ref_type TEXT,
        ref_value TEXT, created_at TEXT);
      CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
        model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER,
        duration_ms REAL, time_to_first_token_ms REAL, output_ttft_ms REAL,
        inter_token_latency_ms REAL, request_multiplier REAL, finish_reason TEXT,
        reasoning_effort TEXT, initiator TEXT, content_filter_triggered INTEGER, created_at TEXT);
    `);
    const sessions = [
      ["demo-cache", "A cache that knows when to let go.", "example/widget-api", "feat/cache",
        "Design a cache invalidation strategy for the widget API.",
        "Use short-lived cache entries and invalidate by resource key after successful writes. Keep cache failures separate from API failures."],
      ["demo-layout", "Making the archive feel like a notebook.", "example/context-notes", "feat/archive",
        "Build a responsive archive with repository filters.",
        "Use a paper background, an editorial grid, and semantic form labels. Repository filters should preserve search input and reset pagination."],
      ["demo-tests", "The edge cases are the interesting part.", "example/widget-api", "test/sqlite",
        "What should we test around read-only SQLite connections?",
        "Test WAL visibility, invalid schemas, parameterized queries, and missing databases. Never open the source database with write access."],
      ["demo-release", "Small tools. Portable by default.", "example/local-tools", "main",
        "Package a local dashboard for Docker without bundling private data.",
        "Use an allowlisted Docker build context and a read-only bind mount. Publish the port on loopback only. Keep fixtures entirely synthetic."],
    ];
    const addSession = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const addTurn = db.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)");
    const addCheckpoint = db.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const addUsage = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    sessions.forEach(([id, title, repo, branch, prompt, answer], index) => {
      const date = `2026-01-${String(20 + index).padStart(2, "0")} 10:00:00`;
      addSession.run(id, title, repo, branch, `/workspace/${repo.split("/")[1]}`, "local", date, date);
      for (let turn = 0; turn < 12; turn++) {
        const first = turn === 0;
        addTurn.run(index * 12 + turn + 1, id, turn,
          first ? prompt : `Follow-up ${turn}: explain the ${["implementation", "trade-offs", "validation"][turn % 3]} for this approach.`,
          first ? `${answer}\n\n## Implementation notes\n\n- Keep boundaries explicit.\n- Test the failure path.\n\n\`\`\`javascript\nconst ttl = 60;\nconst cacheKey = "widget:42";\nconsole.log({ ttl, cacheKey });\n\`\`\`\n\nUse \`readOnly: true\` for the data connection.\n\n| Boundary | Behavior |\n| --- | --- |\n| Local data | Read-only |\n| Network | Loopback |` :
            `${answer}\n\nStep ${turn}: keep the implementation explicit, document the boundary, and verify it with a focused test.`,
          `2026-01-${String(20 + index).padStart(2, "0")} 10:${String(turn).padStart(2, "0")}:00`);
        addUsage.run(index * 12 + turn + 1, id, turn, index % 2 ? "gpt-5.4-mini" : "claude-sonnet-5",
          1000, 200, turn % 3 === 0 ? 500 : null, index % 2 ? 0 : 50, 20, 1e9, 2000, 150, 200, 12, 1,
          turn % 5 === 0 ? "length" : "stop", index % 2 ? "low" : "high",
          turn % 2 ? "agent" : "user", 0,
          `2026-01-${String(20 + index).padStart(2, "0")} 10:${String(turn).padStart(2, "0")}:00`);
      }
      addCheckpoint.run(index + 1, id, 1, `Decision record / ${branch}`, answer,
        "Explored requirements and compared implementation options.",
        "Completed the first working implementation.",
        index === 0 ? "Cache TTL: 60 seconds. Invalidate after commit." : "Read-only local data, no remote API calls.",
        "src/index.js, test/index.test.js",
        "Review edge cases before the next release.", date);
      db.prepare("INSERT INTO session_files VALUES (?, ?, ?, ?, ?)").run(index + 1, id, "src/index.js", "apply_patch", date);
      db.prepare("INSERT INTO session_refs VALUES (?, ?, ?, ?, ?)").run(index + 1, id, "issue", "42", date);
    });
  } finally {
    db.close();
  }
}
