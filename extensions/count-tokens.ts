import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const { Box, Text } = piTui;
// MouseRegion only exists in newer pi versions; if it's missing, clicking is just skipped.
const MouseRegion = (piTui as any).MouseRegion;

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "obj",
  "bin",
  ".vs",
  ".vscode",
]);

type SkippedPath = {
  path: string;
  reason: string;
};

type CountedFile = {
  path: string;
  tokens: number;
};

// Click-to-expand state, keyed by message id so it survives re-renders.
const clickToggled = new Set<string>();
let messageCounter = 0;
const nextMessageId = () => `${Date.now()}-${messageCounter++}`;

// A small collapsible block.
// Ctrl+O (pi's global toggle) and a click are combined: a click flips this one block.
class ToggleBlock {
  constructor(
    private key: string,
    private piExpanded: boolean,
    private theme: any,
    private headerColor: string,
    private headerText: string,
    private body: string,
  ) {}

  toggle() {
    if (clickToggled.has(this.key)) clickToggled.delete(this.key);
    else clickToggled.add(this.key);
  }

  render(width: number): string[] {
    const expanded = this.piExpanded !== clickToggled.has(this.key);
    const header = this.theme.fg(this.headerColor, this.headerText);

    const text = expanded
      ? `${header}\n${this.body}`
      : header + this.theme.fg("dim", " (click or Ctrl+O to expand)");

    const box = new Box(1, 1, (t: string) =>
      this.theme.bg("customMessageBg", t),
    );
    box.addChild(new Text(text, 0, 0));
    return box.render(width);
  }

  invalidate() {}
}

// Wraps a ToggleBlock so a left click toggles it (fullscreen mode only).
// Ctrl+O still works in every mode.
function makeBlock(
  key: string,
  piExpanded: boolean,
  theme: any,
  headerColor: string,
  headerText: string,
  body: string,
) {
  const block = new ToggleBlock(
    key,
    piExpanded,
    theme,
    headerColor,
    headerText,
    body,
  );
  if (!MouseRegion) return block;

  return new MouseRegion(block, (event: any) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    block.toggle();
    return { handled: true, render: true };
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(
    "count-tokens-counted",
    (message, { expanded }, theme) => {
      const {
        id = "",
        counted = [],
        totalTokens = 0,
      } = (message.details ?? {}) as {
        id?: string;
        counted?: CountedFile[];
        totalTokens?: number;
      };

      const header = `Counted files (${counted.length}) — ${totalTokens.toLocaleString()} tokens`;

      const body = counted
        .map(
          (item, i) =>
            `${i + 1}. ${item.path} (${item.tokens.toLocaleString()} tokens)`,
        )
        .join("\n");

      return makeBlock(`counted-${id}`, expanded, theme, "success", header, body);
    },
  );

  pi.registerMessageRenderer(
    "count-tokens-skipped",
    (message, { expanded }, theme) => {
      const { id = "", skipped = [] } = (message.details ?? {}) as {
        id?: string;
        skipped?: SkippedPath[];
      };

      const header = `Skipped paths (${skipped.length})`;

      const body = skipped
        .map((item, i) => `${i + 1}. ${item.path}\n   Reason: ${item.reason}`)
        .join("\n\n");

      return makeBlock(`skipped-${id}`, expanded, theme, "warning", header, body);
    },
  );

  pi.registerCommand("count-tokens", {
    description: "Count tokens with progress and skipped-file report",

    handler: async (args, ctx) => {
      const target = path.resolve(ctx.cwd, args.trim() || ".");
      const model = ctx.model;

      if (!model) {
        ctx.ui.notify("No model is currently selected.", "error");
        return;
      }

      const tokenizeUrl = new URL("/tokenize", model.baseUrl).toString();

      let totalTokens = 0;
      let filesCounted = 0;
      let filesDiscovered = 0;
      let filesProcessed = 0;
      let currentFile = "";

      const skipped: SkippedPath[] = [];
      const counted: CountedFile[] = [];

      function renderProgress() {
        const percent =
          filesDiscovered === 0
            ? 100
            : Math.min(
                100,
                Math.floor((filesProcessed / filesDiscovered) * 100),
              );

        const width = 24;
        const filled = Math.floor((percent / 100) * width);
        const bar = "█".repeat(filled) + "░".repeat(width - filled);

        ctx.ui.setWidget("count-tokens-progress", [
          `Counting tokens: ${bar} ${percent}%`,
          `Files: ${filesProcessed}/${filesDiscovered}`,
          `Current: ${currentFile || "Scanning..."}`,
        ]);

        ctx.ui.setStatus(
          "count-tokens",
          `Token count ${percent}% (${filesProcessed}/${filesDiscovered})`,
        );
      }

      async function tokenize(content: string): Promise<number> {
        if (!content.length) return 0;

        const response = await fetch(tokenizeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            model: model.id,
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          const details = await response.text().catch(() => "");
          throw new Error(
            `Tokenization failed: HTTP ${response.status}` +
              (details ? ` — ${details}` : ""),
          );
        }

        const data = (await response.json()) as { tokens?: unknown };

        if (!Array.isArray(data.tokens)) {
          throw new Error("Invalid response from tokenize endpoint.");
        }

        return data.tokens.length;
      }

      // First pass: count eligible files and record anything unexpected that gets skipped.
      async function discover(filePath: string): Promise<void> {
        let info;

        try {
          info = await stat(filePath);
        } catch (error) {
          skipped.push({
            path: filePath,
            reason: `Cannot access: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return;
        }

        if (info.isDirectory()) {
          // Ignored directories are skipped silently (not reported).
          if (IGNORED_DIRS.has(path.basename(filePath))) return;

          let entries;

          try {
            entries = await readdir(filePath, { withFileTypes: true });
          } catch (error) {
            skipped.push({
              path: filePath,
              reason: `Cannot read directory: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
            return;
          }

          for (const entry of entries) {
            const child = path.join(filePath, entry.name);

            if (entry.isSymbolicLink()) {
              skipped.push({
                path: child,
                reason: "Symbolic link not followed",
              });
            } else {
              await discover(child);
            }
          }
          return;
        }

        if (!info.isFile()) return;

        if (info.size > MAX_FILE_SIZE) {
          skipped.push({ path: filePath, reason: "Larger than 10 MB" });
          return;
        }

        try {
          const buffer = await readFile(filePath);

          if (buffer.includes(0)) {
            skipped.push({ path: filePath, reason: "Binary file" });
            return;
          }
        } catch (error) {
          skipped.push({
            path: filePath,
            reason: `Cannot read file: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return;
        }

        filesDiscovered++;
      }

      // Second pass: actually tokenize the files.
      async function scan(filePath: string): Promise<void> {
        const info = await stat(filePath);

        if (info.isDirectory()) {
          if (IGNORED_DIRS.has(path.basename(filePath))) return;

          const entries = await readdir(filePath, { withFileTypes: true });

          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            await scan(path.join(filePath, entry.name));
          }
          return;
        }

        if (!info.isFile() || info.size > MAX_FILE_SIZE) return;

        let buffer: Buffer;

        try {
          buffer = await readFile(filePath);
        } catch {
          return;
        }

        if (buffer.includes(0)) return;

        currentFile = path.relative(target, filePath) || path.basename(filePath);
        renderProgress();

        const fileTokens = await tokenize(buffer.toString("utf8"));
        totalTokens += fileTokens;
        counted.push({ path: currentFile, tokens: fileTokens });
        filesCounted++;
        filesProcessed++;

        renderProgress();
      }

      try {
        const info = await stat(target);

        if (!info.isFile() && !info.isDirectory()) {
          throw new Error("Path is not a file or directory.");
        }

        currentFile = "Discovering files...";
        renderProgress();
        await discover(target);

        currentFile = "Starting...";
        renderProgress();
        await scan(target);

        currentFile = "Complete";
        renderProgress();

        ctx.ui.notify(
          [
            `Tokens: ${totalTokens.toLocaleString()}`,
            `Files counted: ${filesCounted}`,
            `Files skipped: ${skipped.length}`,
          ].join("\n"),
          "info",
        );

        const runId = nextMessageId();

        // Collapsible list of counted files.
        if (counted.length) {
          pi.sendMessage({
            customType: "count-tokens-counted",
            content: `Counted files (${counted.length})`,
            display: true,
            details: { id: runId, counted, totalTokens },
          });
        }

        // Collapsible list of skipped paths (only shown if something was skipped).
        if (skipped.length) {
          pi.sendMessage({
            customType: "count-tokens-skipped",
            content: `Skipped paths (${skipped.length})`,
            display: true,
            details: { id: runId, skipped },
          });
        }
      } catch (error) {
        ctx.ui.notify(
          `Could not count tokens: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      } finally {
        ctx.ui.setWidget("count-tokens-progress", undefined);
        ctx.ui.setStatus("count-tokens", undefined);
      }
    },
  });
}