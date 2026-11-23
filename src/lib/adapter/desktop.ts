import { isAgentKey } from "./types";
import type {
  Account,
  AgentKey,
  AgentProbe,
  CatalogEntry,
  ChatRequest,
  CredentialStatus,
  CredentialKey,
  GatewayKey,
  ProviderCallOpts,
  ProviderKey,
  StreamEvent,
  Transport,
} from "./types";

/*
 * Desktop transport — the real one.
 *
 * Every call crosses into Rust, which is the point: the API key is written to
 * the OS keychain and read back only inside the process that makes the HTTPS
 * request, so it never exists as a string in the webview.
 *
 * `@tauri-apps/api` is imported lazily so a browser build never pulls it in.
 */

async function core() {
  return import("@tauri-apps/api/core");
}

/*
 * Gateways get one command set each; the two CLI agents share one, because on
 * the Rust side they differ only by which binary gets spawned. `agent` is
 * passed as an argument rather than baked into the command name for the same
 * reason.
 */
function commands(provider: GatewayKey) {
  switch (provider) {
    case "openrouter":
      return {
        catalog: "openrouter_catalog",
        account: "openrouter_account",
        chat: "openrouter_chat",
      } as const;
    case "zai":
      return {
        catalog: "zai_catalog",
        account: "zai_account",
        chat: "zai_chat",
      } as const;
    case "deepseek":
      return {
        catalog: "deepseek_catalog",
        account: "deepseek_account",
        chat: "deepseek_chat",
      } as const;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export const desktopTransport: Transport = {
  kind: "desktop",

  async credentialStatus(provider: CredentialKey) {
    const { invoke } = await core();
    return invoke<CredentialStatus>("credential_status", { provider });
  },

  async credentialSet(provider: CredentialKey, key: string) {
    const { invoke } = await core();
    return invoke<CredentialStatus>("credential_set", { provider, key });
  },

  async credentialClear(provider: CredentialKey) {
    const { invoke } = await core();
    return invoke<CredentialStatus>("credential_clear", { provider });
  },

  async agentProbe(provider: AgentKey) {
    const { invoke } = await core();
    return invoke<AgentProbe>("agent_probe", { agent: provider });
  },

  async migrateZaiCodingCredential() {
    const { invoke } = await core();
    await invoke("credential_migrate_zai_coding");
  },

  async research(streamId, request) {
    const { invoke } = await core();
    return invoke("research_fetch", { streamId, request });
  },

  async oracleDoc(page) {
    const { invoke } = await core();
    return invoke("oracle_doc", { page });
  },

  async catalog(provider: ProviderKey) {
    const { invoke } = await core();
    if (isAgentKey(provider)) {
      return invoke<CatalogEntry[]>("agent_catalog", { agent: provider });
    }
    return invoke<CatalogEntry[]>(commands(provider).catalog);
  },

  async account(provider: ProviderKey, opts?: ProviderCallOpts) {
    const { invoke } = await core();
    if (isAgentKey(provider)) {
      return invoke<Account>("agent_account", { agent: provider });
    }
    if (provider === "zai") {
      return invoke<Account>("zai_account", {
        codingPlan: opts?.zaiPlan === "coding",
      });
    }
    return invoke<Account>(commands(provider).account);
  },

  async usage(provider: ProviderKey, opts?: ProviderCallOpts) {
    const { invoke } = await core();
    return invoke("provider_usage", { provider, codingPlan: opts?.zaiPlan === "coding" });
  },

  async chat(
    provider: ProviderKey,
    streamId: string,
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
    opts?: ProviderCallOpts,
  ) {
    const { invoke, Channel } = await core();
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;

    if (isAgentKey(provider)) {
      await invoke("agent_chat", {
        streamId,
        agent: provider,
        request,
        onEvent: channel,
      });
      return;
    }
    if (provider === "zai") {
      await invoke("zai_chat", {
        streamId,
        request,
        onEvent: channel,
        codingPlan: opts?.zaiPlan === "coding",
      });
      return;
    }
    await invoke(commands(provider).chat, {
      streamId,
      request,
      onEvent: channel,
    });
  },

  // The stream registry is keyed by id alone, so one command stops any turn.
  cancel(_provider: ProviderKey, streamId: string) {
    void core().then(({ invoke }) => invoke("stream_cancel", { streamId }));
  },
};
