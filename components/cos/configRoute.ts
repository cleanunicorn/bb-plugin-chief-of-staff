// Configure's sections in the page address: `config/<section>` under the
// dashboard's path. Keep this module free of imports: app.tsx and
// configurator.tsx both use it, and tests mock the configurator on its own.

export const CONFIG_SECTIONS = ["workflow", "repos", "general", "access", "advanced"] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/** The section a dashboard sub-path names. Unknown or missing gives Workflows; segments after the section are ignored. */
export function configSectionFromSubPath(subPath: string): ConfigSection {
  const second = decodeURIComponent(subPath.split("/")[1] ?? "");
  return (CONFIG_SECTIONS as readonly string[]).includes(second) ? (second as ConfigSection) : "workflow";
}

/** The dashboard sub-path that shows `section`. */
export function configSubPath(section: ConfigSection): string {
  return `config/${section}`;
}
