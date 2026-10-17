# Universal GitHub Highlighting

A Manifest V3 Chrome extension that colors code GitHub leaves unhighlighted, using the local [gpu-lexer](https://github.com/vercel-labs/gpu-lexer) WebGPU model. No language selection, grammar packs, accounts, backend, telemetry, or external requests.

## Build and install

Requires Node.js 22+ and a current desktop Chrome with WebGPU enabled.

```sh
npm ci
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository's `dist` directory.
3. Open a source file on `https://github.com`, or reload GitHub tabs opened before installation.

Everything needed at runtime, including model weights and WGSL shaders, is bundled locally. The model lives in `dist/gpu-worker.js`, so it is not loaded into each GitHub tab. No model downloads occur. Building needs npm access; using the installed extension does not need any service beyond GitHub itself.

Click the extension's toolbar icon to enable/disable highlighting globally. The popup lists each detected file or Markdown block and its state. **Force highlight** applies to that individual surface until navigation or disabling the extension; it can override GitHub's own colors. Disabled state is stored locally and applies to all GitHub tabs. GPU failures appear in the popup; disable and re-enable highlighting to restart the shared runtime and retry.

The background HTML page is created lazily when you visit GitHub. It warms one WebGPU model shared by all GitHub tabs, retaining it across file navigation, page reloads, and service-worker restarts. After the last GitHub tab closes or navigates away, a three-minute grace period begins. Returning to GitHub cancels cleanup. When that period expires, the HTML page and its dedicated worker are closed, releasing the model and GPU memory. Chrome may delay the cleanup alarm while the computer is asleep. Disabling highlighting closes the runtime immediately.

Highlight span caches stay in each page. Unchanged code can repaint synchronously without messaging the background worker, and there is no persistent source/result cache in the background.

## Behavior

- Automatically checks rendered code for actual syntax tokens (`pl-*`, other token spans, or explicit text colors). Filenames and extensions do not determine eligibility. Even one nonempty syntax token causes automatic highlighting to defer to GitHub for the entire surface.
- Supports current React repository blob views, legacy source tables, unified/split PR diff tables, React diff text cells, and fenced/indented Markdown code blocks.
- Leaves inline Markdown code, editors, binary files, raw-file pages, and unrelated UI alone.
- Colors all nine model classes with GitHub theme variables. Theme changes update colors without rerunning the model.
- Uses CSS Custom Highlights over DOM `Range`s. It never wraps tokens, replaces code containers, or changes source text. Links, line numbers, diff signs, word-change backgrounds, selection, and event handlers remain GitHub's own elements.

Recognized languages with no styled tokens at all (for example, a file containing only an identifier) may still receive automatic coloring. Conversely, one styled token in a mostly plain file conservatively prevents automatic coloring; use **Force highlight** when needed. Plain prose can also be colored: the model does not decide whether text is a programming language.

## Limits

- At most **60,000 UTF-16 code units per surface** and **240,000 per page** are processed. Diff context included in both revisions counts twice. Oversized files are skipped, including for manual force. There is no silent truncation.
- Only loaded source rows/hunks can be inferred. Collapsed, unloaded, and virtualized content is processed when GitHub renders it. Context outside a visible diff hunk is unavailable; multiline syntax crossing omitted context can be misclassified.
- Old and new diff revisions are inferred separately, with a new input at hunk boundaries. Unified context is painted from the new revision; split context is painted separately on each side.
- GitHub's DOM is not a public API. The inspected React blob layout and legacy PR tables are verified on live GitHub. React diff classes are covered with representative fixtures, but an authenticated React PR rollout was not available for live verification. Future layouts without these source elements are left intact until an adapter is added.
- Requires the CSS Custom Highlight API and a functioning WebGPU adapter in the background worker. A missing API, rejected initialization, device failure, or 20-second GPU timeout leaves original rendering intact; the page client allows 30 seconds for host startup and messaging. GPU failure is latched until the runtime is restarted to prevent repeated initialization loops. The package does not expose GPU cancellation/disposal; completed stale results are ignored, and closing the offscreen document terminates its worker and releases the runtime.
- The learned model is approximate. It is a visual highlighter, not a parser or a source of semantic information.

## Implementation

| Module | Responsibility |
| --- | --- |
| `src/dom.ts` | Surface discovery, native syntax detection, revision/hunk extraction |
| `src/lexer.ts`, `src/protocol.ts` | Per-page span cache, background request client, timeout/failure handling |
| `src/background.ts`, `src/runtime-host.ts` | GitHub tab tracking, lazy host creation, three-minute cleanup alarm, service-worker restart recovery |
| `src/offscreen.ts`, `src/gpu-worker.ts` | Hidden HTML host, dedicated worker, actual `parse(source)` API, shared WebGPU singleton |
| `src/render.ts` | UTF-16 text-node mapping, span validation, CSS Highlight registry |
| `src/controller.ts` | Frame-batched scans, narrow mutation filtering, navigation, stale-work checks, page limits |
| `src/content.ts` | Extension storage and popup message boundary |
| `src/popup.ts` | Global toggle, per-surface force controls, availability status |

The bundled lexer runs in a **dedicated worker hosted by an extension offscreen HTML document**. The offscreen `WORKERS` reason is used because that document actually spawns the worker. A service worker starts the host on GitHub visits, brokers inference requests, and uses Chrome alarms for cleanup. A single real-token call to the public `parse(source)` API warms the package's singleton. The offscreen document survives service-worker suspension; startup reconciles Chrome's current tabs, contexts and existing alarm without resetting the idle deadline. Lifecycle creation and teardown are serialized to prevent duplicate hosts and stale-alarm races. No scripts or workers are injected into GitHub's main world, and the page's CSP does not apply to the extension host.

The content script starts at DOM readiness and scans immediately. Subsequent updates are batched before the next paint without a settling delay; ongoing mutations cannot keep postponing a scan. The controller listens for Turbo/PJAX events, browser Navigation API completion, history traversal, and page restoration. A MutationObserver watches repository content (or `main`) for source changes and additions. Rendering has no DOM mutations, so it cannot feed back into the observer. Source changes, detached nodes, toggles, and route changes invalidate pending rendering. Up to twelve distinct inputs are cached per page, allowing unchanged source to repaint synchronously after GitHub replaces its DOM nodes. Model preparation and inference execute outside the GitHub page. The first GitHub visit after runtime cleanup still incurs initialization; subsequent pages share the already-warm model. Source content stays visible throughout.

The only runtime dependency is pinned `gpu-lexer@0.0.3`. Build dependencies are TypeScript/esbuild; Playwright is used for testing. The extension requests `storage`, `offscreen`, `alarms`, and host access limited to `https://github.com/*` (to track GitHub tabs without unrestricted browsing-history access). It exposes no web-accessible resources and has no network client code.

## Tests

```sh
npx playwright install chromium
npm run check
```

`npm run check` typechecks, builds, and runs real-browser tests. The suite covers UTF-16 surrogate pairs/combining marks, nested nodes, malformed spans, diff extraction, native syntax preservation, original markup/handlers, source selection, duplicate work, changed/replaced nodes, navigation, toggles during inference, BFCache restoration, missing WebGPU, GPU rejection, large-file limits, and theme changes.

Packaged-extension tests load `dist` into an isolated persistent Chrome profile. They exercise the popup and real offscreen `gpu-lexer` model on network-intercepted GitHub fixtures with a restrictive CSP, and assert that no external HTTP requests occur. Lifecycle tests cover multiple tabs, reloads, last-tab departure, the three-minute alarm deadline, reopening during the grace period, runtime teardown/recreation, service-worker restart recovery, and stale-alarm races. Failure tests disable GPU access for the browser while ensuring the page remains untouched. Require the real GPU model test with:

```sh
EXPECT_WEBGPU=1 npm run check
```

To use an existing **Chrome for Testing** or Chromium executable, set `CHROME_PATH` to its absolute path. Regular branded Chrome may reject unpacked-extension command-line loading; manual installation still works.

An optional online smoke test verifies an unrecognized `.hd` source file, real GitHub client navigation, recognized JavaScript, and a PR diff:

```sh
npm run verify:live
```

It reads public GitHub pages, saves screenshots and a JSON report in `test-results/`, and uses a temporary browser profile. Set `UNKNOWN_URL` to test another unhighlighted file; the hd-lang-specific navigation check is then skipped. This development script's navigation requests are separate from the offline extension runtime.

## Research and attribution

Before implementation, inspected upstream [README/API](https://github.com/vercel-labs/gpu-lexer#readme), [runtime initialization and batching](https://github.com/vercel-labs/gpu-lexer/blob/main/packages/core/src/gpu.js), [singleton entry point](https://github.com/vercel-labs/gpu-lexer/blob/main/packages/core/src/index.js), and published package contents. The package includes learned weights/shaders locally and returns UTF-16 offsets.

Inspected live [React source rows](https://github.com/vercel-labs/gpu-lexer/blob/main/.gitignore) (`.react-code-lines .react-file-line`) and [PR diff tables](https://github.com/vercel-labs/gpu-lexer/pull/2/files) (`.blob-code-inner`, separate number/sign/hunk elements). Execution and rendering decisions follow Chrome's [offscreen document lifecycle](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [alarm persistence](https://developer.chrome.com/docs/extensions/reference/api/alarms), [isolated-world/CSP documentation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), and the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API).

`gpu-lexer` is MIT licensed, copyright Shu Ding. Its license is copied into `dist/gpu-lexer.LICENSE` and must accompany distribution.

The extension icon is a white Octocat silhouette inside a charcoal GPU chip with a rainbow border. The transparent master is in `assets/icon-master.png`; Chrome-sized PNGs are in `public/icons/`. It was created with the built-in image generation tool using the prompt saved in `assets/icon-prompt.txt`, then downscaled to 16, 32, 48, and 128 pixels.
