# pi-count-tokens

A [pi](https://pi.dev) extension that adds a `/count-tokens` command. It counts how many tokens a file or folder would use with your **currently selected model's own tokenizer**, shows live progress, and reports what it counted and skipped in collapsible lists.

## Install

```
pi install npm:pi-count-tokens
```

To try it without installing:

```
pi -e npm:pi-count-tokens
```

## Usage

```
/count-tokens            # count the current working directory
/count-tokens src        # count a folder
/count-tokens README.md  # count a single file
```

Paths are resolved relative to the directory pi is running in.

While it runs you'll see a progress bar, the number of files processed, and the file currently being tokenized. When it finishes you get:

- A summary notification with the total tokens, files counted, and files skipped.
- A collapsible **Counted files** message listing every file with its own token count.
- A collapsible **Skipped paths** message listing anything that couldn't be counted, with the reason. This only appears if something was skipped.

### Expanding and collapsing

Both lists start collapsed to a single line.

- **Ctrl+O** expands or collapses everything (pi's standard expand toggle).
- **Click** a list's header line to expand or collapse just that one. Mouse input only works in pi's fullscreen mode (`pi --tui-mode fullscreen`, or `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json`). In regular mode, use Ctrl+O.

## Requirements

Token counts come from the model server itself, so the selected model's server must provide a `POST /tokenize` endpoint at the root of its base URL (for example, llama.cpp's server does). The extension sends:

```json
{ "content": "<file text>", "model": "<model id>" }
```

and expects a response containing a `tokens` array. Its length is the token count. If the endpoint is missing or returns something else, the command stops and shows the error. Each request has a 15 second timeout.

### Authentication

If the selected model's server requires an API key, the extension sends it as `Authorization: Bearer <key>`, resolving the key the same way pi does:

1. A stored credential for the model's provider (`~/.pi/agent/auth.json`, e.g. from `/login`), or
2. The provider's `apiKey` in `~/.pi/agent/models.json` — literal value, `"$ENV_VAR"` / `"${ENV_VAR}"` interpolation, or `"!command"` output.

Custom `headers` configured for the provider or model are resolved the same way and sent along, and take precedence over the `Authorization` header. Servers without a key are called as before, with no auth header.

**OAuth / account logins** (Claude Pro/Max, GitHub Copilot, etc.) work too: the stored access token is sent as `Bearer`. One limitation — this extension cannot refresh an expired token (token refresh is pi-internal, not exposed to extensions). If the stored token is expired, the command tells you to send a message first (which makes pi refresh and persist a fresh token) or run `/login` again. Providers with non-header auth (AWS SigV4, Google Vertex ADC) are not supported — they don't expose `/tokenize` endpoints anyway.

## What gets skipped

These are never counted:

| Skipped | Reported? |
| --- | --- |
| `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `obj`, `bin`, `.vs`, `.vscode` folders | No (ignored silently) |
| Symbolic links (not followed) | Yes |
| Files larger than 10 MB | Yes |
| Binary files (anything containing a null byte) | Yes |
| Files or folders that can't be read | Yes |

## Privacy

This extension reads the files under the path you give it and sends their contents to the selected model's `/tokenize` endpoint. If that server is remote, your file contents leave your machine. Point it at a folder you're comfortable sharing with that server. Nothing is sent anywhere else, and nothing is written to disk.

Like all pi packages, extensions run with full system access, so review the source before installing.

## License

MIT