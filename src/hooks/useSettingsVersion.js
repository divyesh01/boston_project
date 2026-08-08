import { useSyncExternalStore } from "react";
import { subscribeSettingsChange, getSettingsVersion } from "@/lib/settingsBus";

// Subscribe a component to settings changes (commission, CC fee, tax rates).
// Returns a version number that increments whenever settings are saved, which
// forces a re-render and recompute of derived figures.
export function useSettingsVersion() {
  return useSyncExternalStore(subscribeSettingsChange, getSettingsVersion);
}