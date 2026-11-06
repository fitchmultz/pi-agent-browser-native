/** Immutable help/document inventory section construction for the canonical capability baseline. */
/** @param {string} token
 * @returns {readonly [string, string]} */
export const root = (token) => ["root help", token];
/** @param {string} id
 * @param {string} title
 * @param {readonly string[]} docTokens
 * @param {readonly (readonly [string, string])[]} upstreamExpectations */
export const section = (id, title, docTokens, upstreamExpectations = []) =>
	Object.freeze({
		id,
		title,
		docTokens: Object.freeze(docTokens),
		upstreamExpectations: Object.freeze(
			upstreamExpectations.map(([help, token]) => Object.freeze({ help, token })),
		),
	});
