// Provider, model and reasoning level fields with autocomplete: the providers
// bb knows, the chosen provider's models, and the chosen model's reasoning
// levels. Suggestions only: any text is accepted, and without the lists (a
// failing lookup, an unknown provider) the fields are plain text inputs.
import { useId } from "react";
import type { ReactNode } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../rpcContract";
import { Field, TextInput } from "./fields";

export interface ProviderOption {
  id: string;
  displayName: string;
  available: boolean;
  enabled: boolean;
}

/** What the fields suggest from: bb's providers and the provider used when a step sets none. */
export interface ModelCatalog {
  providers: readonly ProviderOption[];
  /** The global default provider id, or "" for bb's own default. */
  defaultProviderId: string;
}

export interface ModelValues {
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
}

/**
 * The models `providerId` offers, to suggest from. Empty (and no lookup) for
 * an empty or unknown provider, or while the lookup has not answered.
 */
export function useProviderModels(providerId: string, providers: readonly ProviderOption[] | undefined) {
  const known = providers?.some((p) => p.id === providerId) ?? false;
  const query = experimental_useRpcQuery<typeof rpcContract, "cos_provider_models">({ contract: rpcContract, method: "cos_provider_models", input: { providerId: providerId || "-" }, enabled: Boolean(providerId) && known });
  return { list: known ? (query.data?.models ?? []) : [], isLoading: Boolean(query.isLoading), error: query.data?.error ?? null };
}

/**
 * One model field outside a step: the default agent's and a repository's.
 * Suggests `providerId`'s models; any text is still accepted.
 */
export function ModelInput({ id, value, onChange, providerId, providers, placeholder }: { id: string; value: string; onChange: (v: string) => void; providerId: string; providers: readonly ProviderOption[]; placeholder?: string }) {
  const listId = `${useId()}-models`;
  const { list } = useProviderModels(providerId.trim(), providers);
  return (
    <>
      <TextInput id={id} list={list.length ? listId : undefined} value={value} onChange={onChange} placeholder={placeholder} mono />
      <datalist id={listId}>
        {list.map((m) => (
          <option key={m.id} value={m.id} label={`${m.displayName}${m.isDefault ? " (default)" : ""}`} />
        ))}
      </datalist>
    </>
  );
}

/** Field errors by key ("providerId", "model", "reasoningLevel"). */
type ErrorOf = (field: keyof ModelValues) => string | undefined;

export function ModelFields({ value, onChange, catalog, error, className, providerHint }: { value: ModelValues; onChange: (patch: ModelValues) => void; catalog: ModelCatalog | null; error: ErrorOf; className?: string; providerHint?: ReactNode }) {
  const base = useId();
  const providerList = `${base}-providers`;
  const modelList = `${base}-models`;
  const levelList = `${base}-levels`;
  const providerId = value.providerId?.trim() ?? "";
  // An empty provider keeps the current one: suggest the default provider's models then.
  const lookup = providerId || catalog?.defaultProviderId.trim() || "";
  const models = useProviderModels(lookup, catalog?.providers);
  const list = models.list;
  const model = list.find((m) => m.id === value.model?.trim());
  const providers = (catalog?.providers ?? []).filter((p) => p.enabled || p.id === providerId);
  const modelHint = !lookup
    ? "Pick an agent to see its models."
    : models.isLoading
      ? "Loading models…"
      : models.error && !list.length
        ? `Models could not be listed: ${models.error}`
        : !providerId && list.length
          ? `Suggestions from the default agent (${lookup}).`
          : undefined;
  return (
    <div className={className}>
      <Field label="Agent (provider)" hint={providerHint} error={error("providerId")}>
        {(id) => (
          <>
            <TextInput id={id} list={providers.length ? providerList : undefined} value={value.providerId ?? ""} onChange={(v) => onChange({ providerId: v || undefined })} placeholder="keep current" mono />
            <datalist id={providerList}>
              {providers.map((p) => (
                <option key={p.id} value={p.id} label={`${p.displayName}${p.available ? "" : " (unavailable)"}`} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label="Model" hint={modelHint} error={error("model")}>
        {(id) => (
          <>
            <TextInput id={id} list={list.length ? modelList : undefined} value={value.model ?? ""} onChange={(v) => onChange({ model: v || undefined })} placeholder="keep current" mono />
            <datalist id={modelList}>
              {list.map((m) => (
                <option key={m.id} value={m.id} label={`${m.displayName}${m.isDefault ? " (default)" : ""}`} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label="Reasoning level" hint={model?.reasoningLevels.length ? `${model.displayName}: ${model.reasoningLevels.join(", ")}` : undefined} error={error("reasoningLevel")}>
        {(id) => (
          <>
            <TextInput id={id} list={model?.reasoningLevels.length ? levelList : undefined} value={value.reasoningLevel ?? ""} onChange={(v) => onChange({ reasoningLevel: v || undefined })} placeholder="keep current" mono />
            <datalist id={levelList}>
              {(model?.reasoningLevels ?? []).map((l) => (
                <option key={l} value={l} label={l === model?.defaultReasoningLevel ? "default" : undefined} />
              ))}
            </datalist>
          </>
        )}
      </Field>
    </div>
  );
}
