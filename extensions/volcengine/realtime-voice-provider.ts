import type {
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceProviderResolveConfigContext,
} from "openclaw/plugin-sdk/realtime-voice";
import { createVolcRealtimeBridge } from "./realtime-voice-bridge.js";

type VolcRealtimeNormalizedConfig = {
  appId?: string;
  accessKey?: string;
  model?: string;
  speaker?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readString(record: unknown, key: string): string | undefined {
  if (record && typeof record === "object" && !Array.isArray(record)) {
    return trimToUndefined((record as Record<string, unknown>)[key]);
  }
  return undefined;
}

function normalizeConfig(raw: unknown): VolcRealtimeNormalizedConfig {
  return {
    appId: readString(raw, "appId") ?? readString(raw, "app_id"),
    accessKey:
      readString(raw, "accessKey") ??
      readString(raw, "access_key") ??
      readString(raw, "accessToken") ??
      readString(raw, "access_token"),
    model: readString(raw, "model"),
    speaker: readString(raw, "speaker") ?? readString(raw, "voice"),
  };
}

export function buildVolcengineRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "volcengine",
    label: "Volcengine Doubao Realtime",
    defaultModel: "1.2.1.1",
    aliases: ["doubao", "doubao-realtime", "volc"],
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: ["pcm16-24khz"],
      outputAudioFormats: ["pcm16-24khz"],
      supportsBargeIn: true,
      supportsToolCalls: false,
      supportsSessionResumption: false,
    },
    resolveConfig: (ctx: RealtimeVoiceProviderResolveConfigContext) => {
      const normalized = normalizeConfig(ctx.rawConfig);
      return {
        ...ctx.rawConfig,
        appId: normalized.appId,
        accessKey: normalized.accessKey,
        model: normalized.model,
        speaker: normalized.speaker,
      };
    },
    isConfigured: (ctx: RealtimeVoiceProviderConfiguredContext) => {
      const normalized = normalizeConfig(ctx.providerConfig);
      return Boolean(normalized.appId && normalized.accessKey);
    },
    createBridge: (req) => {
      const normalized = normalizeConfig(req.providerConfig);
      if (!normalized.appId || !normalized.accessKey) {
        throw new Error("Volcengine realtime provider requires appId and accessKey");
      }
      return createVolcRealtimeBridge({
        ...req,
        appId: normalized.appId,
        accessKey: normalized.accessKey,
        model: normalized.model ?? (req.providerConfig?.model as string | undefined),
        speaker: normalized.speaker,
      });
    },
  };
}
