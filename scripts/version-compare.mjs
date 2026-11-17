/** Version floor comparison shared by the doctor CLIs. */
import { gte, parse } from "semver";

/**
 * Compare two version strings at major.minor.patch precision.
 * Returns undefined when either side is not a stable version, or when `actual`
 * carries a `v` prefix such as the one `node --version` prints.
 * @param {unknown} actual
 * @param {unknown} minimum
 */
export function versionAtLeast(actual, minimum) {
	const parsedActual = parse(String(actual));
	const parsedMinimum = parse(String(minimum));
	if (!parsedActual || !parsedMinimum || String(actual).startsWith("v")) {
		return;
	}
	return gte(
		`${parsedActual.major}.${parsedActual.minor}.${parsedActual.patch}`,
		`${parsedMinimum.major}.${parsedMinimum.minor}.${parsedMinimum.patch}`,
	);
}
