// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import { PcmBinaryWebSocketRealtimeTalkTransport } from "./realtime-talk-pcm-binary.ts";
import type {
  RealtimeTalkGatewayRelaySessionResult,
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";
import { createTransport } from "./realtime-talk.ts";

function makeCtx(): RealtimeTalkTransportContext {
  return {
    client: {} as GatewayBrowserClient,
    sessionKey: "test-key",
    callbacks: {},
  };
}

const audioContract = {
  inputEncoding: "pcm16" as const,
  inputSampleRateHz: 16000,
  outputEncoding: "pcm16" as const,
  outputSampleRateHz: 24000,
};

function makeWebSocketSession(protocol: string): RealtimeTalkJsonPcmWebSocketSessionResult {
  return {
    provider: "test",
    transport: "provider-websocket",
    protocol,
    clientSecret: "secret",
    websocketUrl: "wss://example.com/ws",
    audio: audioContract,
  };
}

function makeGatewayRelaySession(): RealtimeTalkGatewayRelaySessionResult {
  return {
    provider: "test",
    transport: "gateway-relay",
    relaySessionId: "relay-1",
    audio: audioContract,
  };
}

describe("createTransport dispatch", () => {
  it("routes pcm-binary to PcmBinaryWebSocketRealtimeTalkTransport", () => {
    const transport = createTransport(makeWebSocketSession("pcm-binary"), makeCtx());
    expect(transport).toBeInstanceOf(PcmBinaryWebSocketRealtimeTalkTransport);
  });

  it("routes google-live-bidi to GoogleLiveRealtimeTalkTransport", () => {
    const transport = createTransport(makeWebSocketSession("google-live-bidi"), makeCtx());
    expect(transport).toBeInstanceOf(GoogleLiveRealtimeTalkTransport);
  });

  it("routes unknown provider-websocket protocol to GoogleLiveRealtimeTalkTransport", () => {
    const transport = createTransport(makeWebSocketSession("unknown-protocol"), makeCtx());
    expect(transport).toBeInstanceOf(GoogleLiveRealtimeTalkTransport);
  });

  it("routes gateway-relay to GatewayRelayRealtimeTalkTransport", () => {
    const transport = createTransport(makeGatewayRelaySession(), makeCtx());
    expect(transport).toBeInstanceOf(GatewayRelayRealtimeTalkTransport);
  });
});
