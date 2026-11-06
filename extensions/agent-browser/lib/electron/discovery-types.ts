export const ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS = 50;
export const ELECTRON_DISCOVERY_MAX_RESULTS = 200;

export type ElectronDiscoveryPlatform = "darwin" | "linux" | "win32";

export interface ElectronAppSensitivity {
	readonly categories: readonly string[];
	readonly level: "likely-sensitive";
	readonly reason: string;
}
export interface ElectronAppDiscovery {
	readonly appPath?: string;
	readonly bundleId?: string | undefined;
	readonly comment?: string | undefined;
	readonly desktopId?: string;
	readonly executablePath: string;
	readonly icon?: string | undefined;
	readonly name: string;
	readonly packageSource?: "desktop" | "flatpak" | "snap";
	readonly platform: ElectronDiscoveryPlatform;
	readonly sensitivity?: ElectronAppSensitivity;
}
export interface ElectronDiscoveryScanLocations {
	readonly darwinApplicationDirectories?: readonly string[];
	readonly flatpakSystemAppDirectory?: string;
	readonly flatpakUserAppDirectory?: string;
	readonly homeDir?: string;
	readonly linuxDesktopDirectories?: readonly string[];
	readonly pathEnv?: string;
	readonly snapBinDirectory?: string;
	readonly snapMountDirectory?: string;
}
export interface DiscoverElectronAppsOptions {
	readonly locations?: ElectronDiscoveryScanLocations;
	readonly maxResults?: number | undefined;
	readonly platform?: NodeJS.Platform | ElectronDiscoveryPlatform;
	readonly query?: string | undefined;
}
export interface ElectronDiscoveryResult {
	readonly apps: readonly ElectronAppDiscovery[];
	readonly maxResults: number;
	readonly omittedCount: number;
	readonly platform: ElectronDiscoveryPlatform | "unsupported";
	readonly query?: string | undefined;
	readonly skippedCount?: number | undefined;
}
export interface ResolvedElectronDiscoveryLocations {
	readonly darwinApplicationDirectories: readonly string[];
	readonly flatpakSystemAppDirectory: string;
	readonly flatpakUserAppDirectory: string;
	readonly homeDir: string;
	readonly linuxDesktopDirectories: readonly string[];
	readonly pathEnv: string;
	readonly snapBinDirectory: string;
	readonly snapMountDirectory: string;
}
export interface LinuxDesktopEntry {
	readonly comment?: string | undefined;
	readonly desktopId: string;
	readonly exec: string;
	readonly filePath: string;
	readonly icon?: string | undefined;
	readonly name: string;
}
export interface ElectronDiscoveryScan {
	readonly apps: readonly ElectronAppDiscovery[];
	readonly skippedCount: number;
}
