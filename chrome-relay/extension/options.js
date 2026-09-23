// Options page for the Browser Relay extension (plain JS: shipped as-is).
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9224;
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const tokenInput = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.local.get({ host: DEFAULT_HOST, port: DEFAULT_PORT, token: "" }).then(stored => {
	hostInput.value = String(stored.host);
	portInput.value = String(stored.port);
	tokenInput.value = String(stored.token);
});

document.getElementById("save").addEventListener("click", async () => {
	const host = String(hostInput.value).trim();
	if (!/^[A-Za-z0-9._-]+$/.test(host)) {
		status.textContent = "invalid host (hostname or IP only)";
		return;
	}
	const port = Number(portInput.value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		status.textContent = "invalid port";
		return;
	}
	await chrome.storage.local.set({ host, port, token: tokenInput.value });
	status.textContent = "saved";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
});
