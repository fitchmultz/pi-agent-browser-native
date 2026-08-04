import { containsManagedSessionRestoreKey, isWrapperManagedSessionName } from "../../managed-session-capabilities.js";
import { isRecord } from "../../parsing.js";

function isWrapperManagedSessionListItem(item: unknown): boolean {
	if (typeof item === "string") return isWrapperManagedSessionName(item);
	if (!isRecord(item)) return false;
	return ["name", "session", "id"].some((key) => isWrapperManagedSessionName(typeof item[key] === "string" ? item[key] : undefined));
}

function containsManagedStateCapability(value: unknown): boolean {
	if (typeof value === "string") return containsManagedSessionRestoreKey(value);
	if (Array.isArray(value)) return value.some(containsManagedStateCapability);
	return isRecord(value) && Object.values(value).some(containsManagedStateCapability);
}

export function filterCallerOwnedSessionListItems(items: unknown[]): unknown[] {
	return items.filter((item) => !isWrapperManagedSessionListItem(item));
}

export function filterCallerOwnedStateListItems(items: unknown[]): unknown[] {
	return items.filter((item) => !containsManagedStateCapability(item));
}

export function filterManagedSessionListRows(data: unknown): unknown {
	if (!isRecord(data) || !Array.isArray(data.sessions)) return data;
	return { ...data, sessions: filterCallerOwnedSessionListItems(data.sessions) };
}

export function filterManagedStateListRows(data: unknown): unknown {
	if (!isRecord(data)) return data;
	return Object.fromEntries(Object.entries(data).map(([key, value]) => [
		key,
		(key === "states" || key === "files") && Array.isArray(value)
			? filterCallerOwnedStateListItems(value)
			: value,
	]));
}
