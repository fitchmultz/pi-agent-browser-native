/** Native POSIX/PowerShell platform command rendering; every required gate contributes to the final exit. */
import { CAPABILITY_BASELINE } from "../agent-browser-capability-baseline.mjs";
import { platformFor } from "./suite-evidence.mjs";

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psSingleQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildPlatformBuildCommand(
	targetName,
	packageName,
	nodeValidationVersion,
	candidate,
) {
	if (platformFor(targetName) === "powershell") {
		const candidateArgs = candidate
			? ` -CandidatePath ${psSingleQuote(candidate.path)} -CandidateSha256 ${psSingleQuote(candidate.sha256)}`
			: "";
		return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\platform-smoke\\platform-build-windows.ps1 -PackageName ${psSingleQuote(packageName)} -NodeValidationVersion ${psSingleQuote(nodeValidationVersion)}${candidateArgs}`;
	}
	const candidateHash = `node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$PACK_FILE"`;
	return [
		`echo "Starting platform-build in $(pwd) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
		`RUN_ROOT=".platform-smoke-runs/platform-build-$(date -u +%Y%m%dT%H%M%SZ)-$$"`,
		`SOURCE_ROOT="$(pwd)"`,
		`PACK_DIR="$SOURCE_ROOT/$RUN_ROOT/pack"`,
		`PI_PROJECT="$SOURCE_ROOT/$RUN_ROOT/pi-project"`,
		`mkdir -p "$PACK_DIR" "$PI_PROJECT"`,
		`echo "PLATFORM_RUN_ROOT=$RUN_ROOT"`,
		`NODE_VERSION=$(node --version)`,
		`echo "PLATFORM_NODE_VERSION=$NODE_VERSION"`,
		`if node -e 'process.exit(process.versions.node.localeCompare(process.argv[1], undefined, { numeric: true }) < 0 ? 1 : 0)' ${shellQuote(nodeValidationVersion)}; then NODE_VERSION_EXIT=0; else NODE_VERSION_EXIT=1; fi`,
		`echo "PLATFORM_NODE_VERSION_EXIT=$NODE_VERSION_EXIT"`,
		`npm ci 2>&1`,
		`NPM_CI_EXIT=$?`,
		`echo "PLATFORM_NPM_CI_EXIT=$NPM_CI_EXIT"`,
		`npm run verify -- platform-target 2>&1`,
		`VERIFY_EXIT=$?`,
		`echo "PLATFORM_VERIFY_EXIT=$VERIFY_EXIT"`,
		`PACK_TARBALL=$(npm pack --silent --pack-destination "$PACK_DIR" 2>"$PACK_DIR/npm-pack.stderr.txt")`,
		`PACK_EXIT=$?`,
		`cat "$PACK_DIR/npm-pack.stderr.txt"`,
		`PACK_FILE="$PACK_DIR/$PACK_TARBALL"`,
		`echo "PLATFORM_NPM_PACK_EXIT=$PACK_EXIT"`,
		...(candidate
			? [
					`CANDIDATE_EXIT=0`,
					`CANDIDATE_SOURCE=${shellQuote(candidate.path)}`,
					`PACK_FILE="$PACK_DIR/release-candidate.tgz"`,
					`if cp "$SOURCE_ROOT/$CANDIDATE_SOURCE" "$PACK_FILE"; then CANDIDATE_BEFORE=$(${candidateHash}); else CANDIDATE_BEFORE=""; fi`,
					`echo "PLATFORM_CANDIDATE_SHA256_BEFORE=$CANDIDATE_BEFORE"`,
					`if [ "$CANDIDATE_BEFORE" != ${shellQuote(candidate.sha256)} ]; then CANDIDATE_EXIT=1; fi`,
				]
			: []),
		`echo "PLATFORM_PACKED_TARBALL=$PACK_FILE"`,
		`PI_CLI="$SOURCE_ROOT/node_modules/.bin/pi"`,
		`if [ ! -x "$PI_CLI" ]; then PI_CLI="$(command -v pi || true)"; fi`,
		`echo "PLATFORM_PI_CLI=$PI_CLI"`,
		`if [ -n "$PACK_TARBALL" ] && [ -f "$PACK_FILE" ]${candidate ? ' && [ "$CANDIDATE_EXIT" -eq 0 ]' : ""}; then (cd "$PI_PROJECT" && npm init -y >"$PACK_DIR/packed-node-install.stdout.txt" 2>"$PACK_DIR/packed-node-install.stderr.txt" && npm install --no-save "$PACK_FILE" >>"$PACK_DIR/packed-node-install.stdout.txt" 2>>"$PACK_DIR/packed-node-install.stderr.txt"); PACKED_NODE_INSTALL_EXIT=$?; else echo "missing or invalid tarball" >"$PACK_DIR/packed-node-install.stderr.txt"; PACKED_NODE_INSTALL_EXIT=1; fi`,
		`echo "PLATFORM_PACKED_NODE_INSTALL_EXIT=$PACKED_NODE_INSTALL_EXIT"`,
		`echo "--- PACKED_NODE_INSTALL_STDOUT START ---"; cat "$PACK_DIR/packed-node-install.stdout.txt" 2>/dev/null || true; echo "--- PACKED_NODE_INSTALL_STDOUT END ---"`,
		`echo "--- PACKED_NODE_INSTALL_STDERR START ---"; cat "$PACK_DIR/packed-node-install.stderr.txt" 2>/dev/null || true; echo "--- PACKED_NODE_INSTALL_STDERR END ---"`,
		`if [ "$PACKED_NODE_INSTALL_EXIT" -eq 0 ] && [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" install -l --approve ./node_modules/${packageName} >"$PACK_DIR/pi-install.stdout.txt" 2>"$PACK_DIR/pi-install.stderr.txt"); PI_INSTALL_EXIT=$?; else echo "missing pi cli or packed install" >"$PACK_DIR/pi-install.stderr.txt"; PI_INSTALL_EXIT=1; fi`,
		`echo "PLATFORM_PI_INSTALL_EXIT=$PI_INSTALL_EXIT"`,
		`echo "--- PI_INSTALL_STDOUT START ---"; cat "$PACK_DIR/pi-install.stdout.txt" 2>/dev/null || true; echo "--- PI_INSTALL_STDOUT END ---"`,
		`echo "--- PI_INSTALL_STDERR START ---"; cat "$PACK_DIR/pi-install.stderr.txt" 2>/dev/null || true; echo "--- PI_INSTALL_STDERR END ---"`,
		`if [ -n "$PI_CLI" ]; then (cd "$PI_PROJECT" && PI_OFFLINE=1 "$PI_CLI" list --approve >"$PACK_DIR/pi-list.stdout.txt" 2>"$PACK_DIR/pi-list.stderr.txt"); PI_LIST_EXIT=$?; else echo "missing pi cli" >"$PACK_DIR/pi-list.stderr.txt"; PI_LIST_EXIT=1; fi`,
		`echo "PLATFORM_PI_LIST_EXIT=$PI_LIST_EXIT"`,
		`echo "--- PI_LIST_STDOUT START ---"; cat "$PACK_DIR/pi-list.stdout.txt" 2>/dev/null || true; echo "--- PI_LIST_STDOUT END ---"`,
		`echo "--- PI_LIST_STDERR START ---"; cat "$PACK_DIR/pi-list.stderr.txt" 2>/dev/null || true; echo "--- PI_LIST_STDERR END ---"`,
		...(candidate
			? [
					`CANDIDATE_AFTER=$(${candidateHash})`,
					`echo "PLATFORM_CANDIDATE_SHA256_AFTER=$CANDIDATE_AFTER"`,
					`if [ "$CANDIDATE_AFTER" != ${shellQuote(candidate.sha256)} ]; then CANDIDATE_EXIT=1; fi`,
				]
			: []),
		`if [ "$NODE_VERSION_EXIT" -ne 0 ] || [ "$NPM_CI_EXIT" -ne 0 ] || [ "$VERIFY_EXIT" -ne 0 ] || [ "$PACK_EXIT" -ne 0 ] || [ "$PACKED_NODE_INSTALL_EXIT" -ne 0 ] || [ "$PI_INSTALL_EXIT" -ne 0 ] || [ "$PI_LIST_EXIT" -ne 0 ]${candidate ? ' || [ "$CANDIDATE_EXIT" -ne 0 ]' : ""}; then echo "PLATFORM_BUILD_FAILED"; exit 1; fi`,
		`echo "PLATFORM_BUILD_OK"`,
	].join("\n");
}

export function buildBrowserDogfoodCommand(
	targetName,
	agentBrowserVersion = CAPABILITY_BASELINE.targetVersion,
	dependenciesReady = false,
) {
	if (platformFor(targetName) === "powershell") {
		return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\platform-smoke\\browser-dogfood-windows.ps1 -AgentBrowserVersion ${psSingleQuote(agentBrowserVersion)}${dependenciesReady ? " -SkipNpmCi" : ""}`;
	}
	return [
		`echo "Starting browser-dogfood-smoke in $(pwd) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
		`RUN_ROOT=".platform-smoke-runs/browser-dogfood-$(date -u +%Y%m%dT%H%M%SZ)-$$"`,
		`SOURCE_ROOT="$(pwd)"`,
		`DOGFOOD_DIR="$SOURCE_ROOT/$RUN_ROOT/dogfood"`,
		`DOGFOOD_ARTIFACT_DIR="$DOGFOOD_DIR/artifacts"`,
		`mkdir -p "$DOGFOOD_ARTIFACT_DIR"`,
		`echo "PLATFORM_RUN_ROOT=$RUN_ROOT"`,
		`echo "PLATFORM_DOGFOOD_ARTIFACT_DIR=$DOGFOOD_ARTIFACT_DIR"`,
		`NODE_VERSION=$(node --version)`,
		`NODE_MAJOR="${"${NODE_VERSION#v}"}"`,
		`NODE_MAJOR="${"${NODE_MAJOR%%.*}"}"`,
		`echo "PLATFORM_NODE_VERSION=$NODE_VERSION"`,
		`EXPECTED_AGENT_BROWSER_VERSION=${shellQuote(`agent-browser ${agentBrowserVersion}`)}`,
		`AGENT_BROWSER_VERSION_OUTPUT=$(agent-browser --version 2>&1)`,
		`AGENT_BROWSER_VERSION_COMMAND_EXIT=$?`,
		`echo "PLATFORM_AGENT_BROWSER_VERSION=$AGENT_BROWSER_VERSION_OUTPUT"`,
		`if [ "$AGENT_BROWSER_VERSION_COMMAND_EXIT" -eq 0 ] && [ "$AGENT_BROWSER_VERSION_OUTPUT" = "$EXPECTED_AGENT_BROWSER_VERSION" ]; then AGENT_BROWSER_READY_EXIT=0; else AGENT_BROWSER_READY_EXIT=1; fi`,
		`echo "PLATFORM_AGENT_BROWSER_READY_EXIT=$AGENT_BROWSER_READY_EXIT"`,
		...(dependenciesReady
			? [
					`if [ -d node_modules ]; then echo "PLATFORM_NPM_CI_SKIPPED=1"; NPM_CI_EXIT=0; else npm ci 2>&1; NPM_CI_EXIT=$?; fi`,
				]
			: [`npm ci 2>&1`, `NPM_CI_EXIT=$?`]),
		`echo "PLATFORM_NPM_CI_EXIT=$NPM_CI_EXIT"`,
		`TSX_CLI="$SOURCE_ROOT/node_modules/.bin/tsx"`,
		`if [ ! -x "$TSX_CLI" ]; then TSX_CLI="$(command -v tsx || true)"; fi`,
		`echo "PLATFORM_TSX_CLI=$TSX_CLI"`,
		`if [ "$NPM_CI_EXIT" -eq 0 ] && [ "$AGENT_BROWSER_READY_EXIT" -eq 0 ] && [ -n "$TSX_CLI" ]; then "$TSX_CLI" scripts/verify-agent-browser-dogfood.ts --artifact-dir "$DOGFOOD_ARTIFACT_DIR" --json >"$DOGFOOD_DIR/dogfood.stdout.txt" 2>"$DOGFOOD_DIR/dogfood.stderr.txt"; DOGFOOD_EXIT=$?; else echo "missing tsx, npm ci failed, or agent-browser baseline mismatch" >"$DOGFOOD_DIR/dogfood.stderr.txt"; DOGFOOD_EXIT=1; fi`,
		`echo "PLATFORM_DOGFOOD_EXIT=$DOGFOOD_EXIT"`,
		`echo "--- DOGFOOD_STDOUT START ---"; cat "$DOGFOOD_DIR/dogfood.stdout.txt" 2>/dev/null || true; echo "--- DOGFOOD_STDOUT END ---"`,
		`echo "--- DOGFOOD_STDERR START ---"; cat "$DOGFOOD_DIR/dogfood.stderr.txt" 2>/dev/null || true; echo "--- DOGFOOD_STDERR END ---"`,
		`if [ "$NPM_CI_EXIT" -ne 0 ] || [ "$AGENT_BROWSER_READY_EXIT" -ne 0 ] || [ "$DOGFOOD_EXIT" -ne 0 ]; then echo "PLATFORM_BROWSER_DOGFOOD_FAILED"; exit 1; fi`,
		`echo "PLATFORM_BROWSER_DOGFOOD_OK"`,
	].join("\n");
}
