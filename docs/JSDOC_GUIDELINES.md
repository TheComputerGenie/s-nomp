# JSDoc Header Guidelines

This document defines the preferred JSDoc header and fileoverview conventions for this project. Follow these rules when adding or updating top-of-file JSDoc headers and class/method documentation. The examples in this document use the project's current style (see `libs/cliListener.js`, `libs/workerapi.js`, and `libs/shareProcessor.js`).

## Goals

- Keep fileoverview headers consistent across the repository.
- Include essential metadata (author, version, copyright).
- Use clear, short descriptions for modules and classes.
- Document public constructors, methods, and emitted events.

## Fileoverview (top-of-file) header

Every source file that implements a module, class, or complex utility should include a fileoverview JSDoc block at the very top. Use the following format and tags in this order:

- `@fileoverview` — one-line summary
- Blank line
- Longer description (1–3 paragraphs max)
- `@author`
- `@version`
- `@copyright`

Example:

```js
/**
 * @fileoverview CLI Listener - TCP admin command listener
 *
 * Provides a small TCP server that accepts newline-terminated JSON commands and
 * emits events for processing by the application.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
```

Notes:
- Keep the summary line concise (under ~80 characters if possible).
- Use sentence-case and avoid trailing punctuation on the `@fileoverview` line.
- The author/version/copyright lines are required for project files.

## Class-level JSDoc

When exporting a class, include a class-level JSDoc immediately above the `class` declaration.
Document what the class represents, the constructor parameters, and any notable behaviors.
Also list events the class emits (if applicable).

Example for a CLI listener:

```js
/**
 * CLI Listener
 *
 * TCP-based admin command listener. Accepts newline-terminated JSON messages
 * containing a { command, params, options } payload and emits events for
 * consumers to handle.
 *
 * Events emitted:
 * - 'command' (command, params, options, callback)
 * - 'log' (message)
 *
 * @class CLIListener
 * @extends EventEmitter
 * @param {string} server - Host or IP address to bind to
 * @param {number} port - TCP port to listen on
 */
```

Guidelines:
- Use `@class` and `@extends` as needed.
- Keep parameter types and short descriptions for each constructor parameter.
- If your class emits events, list them and the payload shapes under "Events emitted".

## Method-level JSDoc

Document public methods with `@returns`, parameter types, and a short description. If a method triggers events or has side effects, note them.

Example:

```js
/**
 * Start the CLI TCP listener. When a newline-terminated JSON message is
 * received it will emit the 'command' event with the parsed payload.
 * @returns {void}
 */
start() { /* ... */ }
```

Tips:
- Prefer small, focused methods — the JSDoc should describe purpose and important details only.
- Use `@returns {void}` for methods that don't return a value.

## Module-level / Endpoint documentation

For modules that expose HTTP endpoints or other well-defined external interfaces, provide a short block describing them. For example, the worker API's `/stats` endpoint documents the JSON shape returned.

Example (abridged):

```js
/**
 * GET /stats endpoint - Returns comprehensive pool statistics
 *
 * @route GET /stats
 * @returns {Object} JSON response containing pool statistics
 * @returns {number} returns.clients - Number of currently connected mining clients
 * @returns {Object} returns.counters - Cumulative performance counters
 */
```

## Metadata

- Author tag: use the canonical project author string `ComputerGenieCo`.
- Version tag: use a semantic tag for internal builds; e.g. `21.7.3`.
- Copyright: 4-digit year only.

## Style and best practices

- Keep descriptions short and factual.
- Use sentence-case and avoid unnecessary adjectives.
- Maintain consistent ordering of tags.
- Limit the length of doc comments to what is necessary — keep implementation details in function bodies or separate developer docs.
- When refactoring to classes, update JSDoc to reflect the new class/method structure (do not leave outdated factory-function comments).

## Example: ShareProcessor (summary)

The `ShareProcessor` class stores a fileoverview header and a class-level doc that explains the constructor (`logger`, `poolConfig`) and usage of `handleShare(isValidShare, isValidBlock, shareData)`.

## Applying the guidelines

- When you add or change a file, update the fileoverview block to include the required metadata.
- Ensure class and method JSDoc blocks reflect the public API developers should use.
- Run a quick `node -e "require('./path/to/module')"` to confirm syntax after edits.
