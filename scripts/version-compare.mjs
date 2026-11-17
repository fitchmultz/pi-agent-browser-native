/**
 * Version floor comparison shared by the doctor CLIs.
 *
 * The platform smoke doctor is packed and run without installed dependencies, so
 * this module reads the first version in each string instead of importing semver.
 */

/** @param {unknown} value */
function readVersion(value) {
	const match = String(value).match(/\d+(?:\.\d+){0,2}/);
	if (match === null) {
		return;
	}
	const [major = "0", minor = "0", patch = "0"] = match[0].split(".");
	return [Number(major), Number(minor), Number(patch)];
}

/**
 * Compare the version each side names, ignoring surrounding text such as the
 * `v` that `node --version` prints or a tool's name prefix.
 * Returns undefined when either side names no version at all.
 * @param {unknown} actual
 * @param {unknown} minimum
 */
export function versionAtLeast(actual, minimum) {
	const parsedActual = readVersion(actual);
	const parsedMinimum = readVersion(minimum);
	if (parsedActual === undefined || parsedMinimum === undefined) {
		return;
	}
	for (let index = 0; index < 3; index += 1) {
		const left = parsedActual[index] ?? 0;
		const right = parsedMinimum[index] ?? 0;
		if (left !== right) {
			return left > right;
		}
	}
	return true;
}
