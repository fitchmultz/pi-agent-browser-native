import { coerce, gte } from "semver";

/**
 * Compare CLI version output with a minimum version.
 * Bare numbers in actual output can be years or warning counts, not versions.
 * @param {unknown} actual
 * @param {unknown} minimum
 */
export function versionAtLeast(actual, minimum) {
	const parsedActual = coerce(String(actual).match(/\d+\.\d+(?:\.\d+)?/)?.[0]);
	const parsedMinimum = coerce(String(minimum));
	if (parsedActual === null || parsedMinimum === null) {
		return;
	}
	return gte(parsedActual, parsedMinimum);
}
