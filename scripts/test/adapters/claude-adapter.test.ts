import { describe, expect, it } from "bun:test";
import {
  buildClaudeCliArgs,
  buildDockerExecEnvArgs,
  buildProgressHint,
  renderPromptTemplate,
} from "../../src/adapters/claude-adapter";

describe("buildProgressHint", () => {
  it("builds hint for DM source with a valid discord user id", () => {
    const hint = buildProgressHint("dm", "123456789012345678");

    expect(hint).toContain("進捗DM送信コマンド");
    expect(hint).toContain("send 123456789012345678");
  });

  it("returns empty string for non-DM sources", () => {
    expect(buildProgressHint("scheduler", "123456789012345678")).toBe("");
    expect(buildProgressHint("manual", "123456789012345678")).toBe("");
  });

  it("returns empty string for invalid ids", () => {
    expect(buildProgressHint("dm", "abc")).toBe("");
    expect(buildProgressHint("dm", undefined)).toBe("");
  });
});

describe("renderPromptTemplate", () => {
  it("injects datetime, progress hint, and message", () => {
    const rendered = renderPromptTemplate(
      [
        "---",
        "channel: cc-discord-bot",
        "source: {{source}}",
        'datetime: "{{datetime}}"',
        "---",
        "",
        "# System Assist",
        "",
        "{{assistant_context}}",
        "",
        "# User Input",
        "",
        "{{user_input}}",
      ].join("\n"),
      {
        datetime: "2026-02-18 12:34",
        source: "dm",
        assistantContext: "assistant-context",
        userInput: "body-line",
      },
    );

    expect(rendered).toContain("2026-02-18 12:34");
    expect(rendered).toContain("source: dm");
    expect(rendered).toContain("assistant-context");
    expect(rendered).toContain("body-line");
  });
});

describe("buildClaudeCliArgs", () => {
  it("inserts '--' before prompt to prevent option parsing", () => {
    const args = buildClaudeCliArgs({
      appendSystemPromptPath: "/tmp/append.md",
      prompt: "---\nchannel: test\n---\nbody",
      sessionId: "sess-1",
      bypassMode: true,
    });

    expect(args).toContain("--");
    const delimiterIndex = args.indexOf("--");
    expect(delimiterIndex).toBeGreaterThanOrEqual(0);
    expect(args[delimiterIndex + 1]).toBe("---\nchannel: test\n---\nbody");
  });
});

describe("buildDockerExecEnvArgs", () => {
  it("includes fixed env and appends custom env", () => {
    const result = buildDockerExecEnvArgs({
      extraEnv: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
      },
    });

    expect(result.args).toEqual([
      "-e",
      "FORCE_COLOR=0",
      "-e",
      "CLAUDECODE=",
      "-e",
      "CLAUDE_CODE_ENABLE_TELEMETRY=1",
      "-e",
      "OTEL_METRICS_EXPORTER=otlp",
    ]);
    expect(result.envKeys).toEqual([
      "FORCE_COLOR",
      "CLAUDECODE",
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_METRICS_EXPORTER",
    ]);
    expect(result.ignoredKeys).toEqual([]);
  });

  it("ignores reserved keys from custom env", () => {
    const result = buildDockerExecEnvArgs({
      extraEnv: {
        FORCE_COLOR: "1",
        CLAUDECODE: "override",
      },
    });

    expect(result.ignoredKeys).toEqual(["CLAUDECODE", "FORCE_COLOR"]);
    expect(result.args).toEqual(["-e", "FORCE_COLOR=0", "-e", "CLAUDECODE="]);
  });
});
