import assert from "node:assert/strict";
import test from "node:test";

import {
	getAllowedDomainsViolation,
	isHostAllowedByDomains,
	parseAllowedDomainsPolicyFromArgs,
} from "../extensions/agent-browser/lib/navigation-policy.js";

test("parseAllowedDomainsPolicyFromArgs supports separated equals comma and whitespace values", () => {
	assert.deepEqual(parseAllowedDomainsPolicyFromArgs(["--allowed-domains", "example.com,docs.example.org other.test"])?.allowedDomains, [
		"example.com",
		"docs.example.org",
		"other.test",
	]);
	assert.deepEqual(parseAllowedDomainsPolicyFromArgs(["--allowed-domains=https://Example.COM:443/path"])?.allowedDomains, ["example.com"]);
	assert.equal(parseAllowedDomainsPolicyFromArgs(["--allowed-domains"]), undefined);
});

test("isHostAllowedByDomains allows exact hosts and subdomains without suffix confusion", () => {
	assert.equal(isHostAllowedByDomains("example.com", ["example.com"]), true);
	assert.equal(isHostAllowedByDomains("www.example.com", ["example.com"]), true);
	assert.equal(isHostAllowedByDomains("badexample.com", ["example.com"]), false);
	assert.equal(isHostAllowedByDomains("www.iana.org", ["example.com"]), false);
});

test("getAllowedDomainsViolation reports http and https outside-domain final URLs only", () => {
	const policy = parseAllowedDomainsPolicyFromArgs(["--allowed-domains", "example.com"]);
	assert.equal(getAllowedDomainsViolation({ policy, url: "https://docs.example.com/page" }), undefined);
	const violation = getAllowedDomainsViolation({ policy, url: "https://www.iana.org/help/example-domains" });
	assert.equal(violation?.observedHost, "www.iana.org");
	assert.match(violation?.summary ?? "", /--allowed-domains example\.com does not allow www\.iana\.org/);
	assert.equal(getAllowedDomainsViolation({ policy, url: "file:///tmp/local.html" }), undefined);
	assert.equal(getAllowedDomainsViolation({ policy, url: "about:blank" }), undefined);
});
