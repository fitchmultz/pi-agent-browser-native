# V1 tool contract

This is the proposed first implementation surface for the native pi `agent-browser` integration.

## Design goals

- keep the tool set small
- avoid giant one-tool-does-everything schemas
- preserve the natural browser workflow
- hide shell quoting/session boilerplate
- leave room for richer renderers later

## Shared conventions

All browser tools accept these common fields where relevant:

- `sessionName?`: explicit browser session name
- `useActiveSession?`: default `true`
- `waitUntil?`: `load | domcontentloaded | networkidle`
- `timeoutMs?`

Extension behavior:

- if no `sessionName` is provided, the extension uses the current active owned session
- if none exists, the extension creates one automatically
- owned sessions are tracked and closed on pi `session_shutdown`

## Tool: `browser_session`

Purpose: create/select/inspect/close browser sessions.

### Actions

- `start`
- `list`
- `select`
- `status`
- `close`
- `close_all_owned`

### Start params

- `sessionName?`
- `headed?`
- `profile?`
- `stateFile?`
- `cdp?`
- `autoConnect?`
- `allowedDomains?`
- `contentBoundaries?`
- `proxy?`
- `viewport?`: `{ width, height, scale? }`
- `device?`

### Result details

- `activeSession`
- `ownedSessions`
- `sessions?`
- `launchOptions?`
- `url?`
- `title?`
- `tabCount?`

## Tool: `browser_page`

Purpose: navigation and page/browser context.

### Actions

- `open`
- `back`
- `forward`
- `reload`
- `wait`
- `tab_list`
- `tab_new`
- `tab_switch`
- `tab_close`
- `frame`
- `frame_main`

### Common params by action

#### `open`
- `url`
- `waitUntil?`

#### `wait`
- `selectorOrMs?`
- `text?`
- `urlPattern?`
- `loadState?`
- `jsCondition?`

#### `tab_new`
- `url?`

#### `tab_switch`
- `index`

#### `tab_close`
- `index?`

#### `frame`
- `target`

### Result details

- `url?`
- `title?`
- `tabs?`
- `frame?`
- `waitMode?`

## Tool: `browser_snapshot`

Purpose: fetch the current page model with refs.

### Actions

- `snapshot`
- `snapshot_interactive`

### Params

- `selector?`
- `compact?`
- `depth?`
- `includeUrls?`

### Result content

- snapshot text

### Result details

- `origin`
- `refs`
- `refCount`
- `interactiveOnly`
- `selector?`

## Tool: `browser_action`

Purpose: interact with the page.

### Actions

- `click`
- `dblclick`
- `fill`
- `type`
- `press`
- `hover`
- `focus`
- `check`
- `uncheck`
- `select`
- `scroll`
- `scroll_into_view`
- `drag`
- `upload`

### Common params by action

#### selector/ref target actions
- `target`

#### `fill` / `type`
- `target`
- `text`

#### `press`
- `key`

#### `select`
- `target`
- `values`

#### `scroll`
- `direction`
- `pixels?`
- `target?`

#### `drag`
- `source`
- `destination`

#### `upload`
- `target`
- `files`

### Result details

- `action`
- `target?`
- `url?`
- `title?`
- `dialogWarning?`

## Tool: `browser_data`

Purpose: extract or inspect structured browser data.

### Actions

- `get_text`
- `get_html`
- `get_value`
- `get_attr`
- `get_title`
- `get_url`
- `get_box`
- `get_styles`
- `eval`
- `network_requests`
- `console`
- `errors`
- `cookies`
- `storage_local`
- `storage_session`

### Common params by action

#### target-based getters
- `target`
- `attributeName?`

#### `eval`
- `script`
- `transport?`: `stdin | base64`

#### `network_requests`
- `filter?`
- `clear?`

#### storage/cookies
- minimal v1 should start read-only

### Result details

- `action`
- `data`
- `url?`
- `title?`

## Tool: `browser_artifact`

Purpose: capture visual/debug artifacts.

### Actions

- `screenshot`
- `pdf`
- `record_start`
- `record_stop`
- `trace_start`
- `trace_stop`
- `profiler_start`
- `profiler_stop`
- `stream_status`

### Params

#### `screenshot`
- `path?`
- `fullPage?`
- `annotate?`

#### `pdf`
- `path?`

#### recording/trace/profiler
- `path?`

### Result content

- screenshots should include the image itself when possible
- other artifacts should include a path summary

### Result details

- `action`
- `path?`
- `stream?`
- `sizeBytes?`

## Session ownership rules

The extension should distinguish:

- **owned sessions**: created by this pi extension
- **external sessions**: explicitly attached by name/CDP/profile

Rules:

- auto-close owned sessions on `session_shutdown`
- do not auto-close external CDP-attached Chrome processes
- surface clear status when reconnecting to a missing session

## Deferred from v1

- full live viewport embedding
- approval UI for risky browser actions
- write-heavy cookies/storage mutation helpers
- full policy editor UI
- every niche CLI command

## Success criteria for v1

- the agent can browse a site without using bash
- snapshots return typed refs and readable text
- screenshots render inline
- session creation/selection/cleanup is automatic
- no shell quoting is required for common workflows
