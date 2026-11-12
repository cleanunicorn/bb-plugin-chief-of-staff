// Unsaved configurator drafts, held by whoever outlives the Configurator: the
// dashboard keeps them across tab switches, the settings page keeps its own.
// The Configurator normalizes every draft against what it loaded, so a non-null
// draft always means an unsaved change, even while the Configurator is unmounted.
// Keep this module free of imports from configurator.tsx: app.tsx imports it, and
// tests mock the configurator module on its own.
import { useCallback, useRef, useState } from "react";
import type { GeneralSettings } from "../../rpcContract";
import type { RepoConfig } from "../../src/config";
import type { WorkflowsDocument } from "../../src/workflow";

export type SaveStatus = { ok: boolean; text: string } | null;

export function useConfigDrafts() {
  const [repos, setRepos] = useState<RepoConfig[] | null>(null);
  /** Only the general settings that differ from the loaded ones. */
  const [general, setGeneral] = useState<Partial<GeneralSettings> | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowsDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveStatus>(null);
  /** Set synchronously on save, so a second click before the next render is a no-op. */
  const savingRef = useRef(false);

  const clear = useCallback(() => {
    setRepos(null);
    setGeneral(null);
    setWorkflow(null);
  }, []);
  const dirty = repos !== null || general !== null || workflow !== null;

  return { repos, setRepos, general, setGeneral, workflow, setWorkflow, saving, setSaving, status, setStatus, savingRef, clear, dirty };
}

export type ConfigDrafts = ReturnType<typeof useConfigDrafts>;
