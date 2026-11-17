/** Version floor comparison shared by the doctor CLIs. */
import { coerce, gte } from "semver";

/**
 * Compare the version each side names, ignoring surrounding text such as the
 * `v` that `node --version` prints or a tool's name prefix.
 * Returns undefined when either side names no version at all.
 * @param {unknown} actual
 * @param {unknown} minimum
 */
export function versionAtLeast(actual, minimum) {
	const parsedActual = coerce(String(actual));
	const parsedMinimum = coerce(String(minimum));
	if (parsedActual === null || parsedMinimum === null) {
		return;
	}
	return gte(parsedActual, parsedMinimum);
}
