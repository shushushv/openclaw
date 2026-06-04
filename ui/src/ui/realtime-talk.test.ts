// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  googleStart,
  googleStop,
  relayStart,
  relayStop,
  webRtcStart,
  webRtcStop,
  relaySupportsVideoMode,
  googleCtor,
  relayCtor,
  webRtcCtor,
} = vi.hoisted(() => ({
  googleStart: vi.fn(async () => undefined),
  googleStop: vi.fn(),
  relayStart: vi.fn(async () => undefined),
  relayStop: vi.fn(),
  webRtcStart: vi.fn(async () => undefined),
  webRtcStop: vi.fn(),
  relaySupportsVideoMode: vi.fn(() => true),
  googleCtor: vi.fn(function () {
    return { start: googleStart, stop: googleStop };
  }),
  relayCtor: vi.fn(function () {
    return { start: relayStart, stop: relayStop, supportsVideoMode: relaySupportsVideoMode };
  }),
  webRtcCtor: vi.fn(function () {
    return { start: webRtcStart, stop: webRtcStop };
  }),
}));

vi.mock("./chat/realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: googleCtor,
}));

vi.mock("./chat/realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: relayCtor,
}));

vi.mock("./chat/realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: webRtcCtor,
}));

import { RealtimeTalkSession } from "./chat/realtime-talk.ts";

describe("RealtimeTalkSession", () => {
  beforeEach(() => {
    googleStart.mockClear();
    googleStop.mockClear();
    relayStart.mockClear();
    relayStop.mockClear();
    relaySupportsVideoMode.mockReset();
    relaySupportsVideoMode.mockReturnValue(true);
    webRtcStart.mockClear();
    webRtcStop.mockClear();
    googleCtor.mockClear();
    relayCtor.mockClear();
    webRtcCtor.mockClear();
  });

  it("starts the Google Live WebSocket transport from a generic session result", async () => {
    const request = vi.fn(async () => ({
      provider: "google",
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      clientSecret: "auth_tokens/session",
      websocketUrl: "wss://example.test/live",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "main", { onStatus });

    await session.start();

    expect(request).toHaveBeenCalledWith("talk.client.create", { sessionKey: "main" });
    expect(googleCtor).toHaveBeenCalledTimes(1);
    expect(googleStart).toHaveBeenCalledTimes(1);
    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("connecting");
  });

  it("defaults legacy session results without an explicit transport to WebRTC", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      clientSecret: "auth_tokens/session",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
  });

  it("accepts legacy WebRTC transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc-sdp",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
  });

  it("accepts legacy provider WebSocket transport names", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
      transport: "json-pcm-websocket",
      clientSecret: "secret",
      protocol: "google-live-bidi",
      websocketUrl: "wss://example.test/live",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();

    expect(webRtcCtor).not.toHaveBeenCalled();
    expect(googleCtor).toHaveBeenCalledTimes(1);
  });

  it("starts the Gateway relay transport for backend-only realtime providers", async () => {
    const request = vi.fn(async () => ({
      provider: "example",
      transport: "gateway-relay",
      relaySessionId: "relay-1",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(relayCtor).toHaveBeenCalledTimes(1);
    expect(relayStart).toHaveBeenCalledTimes(1);
    expect(relayStop).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
    expect(webRtcCtor).not.toHaveBeenCalled();
  });

  it("fails visibly when the selected video mode is unsupported", async () => {
    relaySupportsVideoMode.mockReturnValue(false);
    const request = vi.fn(async () => ({
      provider: "google",
      transport: "gateway-relay",
      relaySessionId: "relay-1",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    }));
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      {
        videoEnabled: true,
        videoMode: "passive",
      },
    );

    await expect(session.start()).rejects.toThrow(
      'Video mode "passive" is not supported for google gateway-relay',
    );

    expect(relayCtor).toHaveBeenCalledTimes(1);
    expect(relaySupportsVideoMode).toHaveBeenCalledWith("passive");
    expect(relayStart).not.toHaveBeenCalled();
    expect(relayStop).toHaveBeenCalledTimes(1);
  });

  it("starts the WebRTC transport for canonical WebRTC sessions", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession({ request } as never, "main");

    await session.start();
    session.stop();

    expect(webRtcCtor).toHaveBeenCalledTimes(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);
    expect(webRtcStop).toHaveBeenCalledTimes(1);
    expect(googleCtor).not.toHaveBeenCalled();
    expect(relayCtor).not.toHaveBeenCalled();
  });

  it("passes launch options to client-owned realtime session creation", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "secret",
    }));
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      {
        provider: "openai",
        model: "gpt-realtime-2",
        voice: "marin",
        transport: "webrtc",
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: "low",
      },
    );

    await session.start();

    expect(request).toHaveBeenCalledWith("talk.client.create", {
      sessionKey: "main",
      provider: "openai",
      model: "gpt-realtime-2",
      voice: "marin",
      transport: "webrtc",
      vadThreshold: 0.45,
      silenceDurationMs: 650,
      prefixPaddingMs: 250,
      reasoningEffort: "low",
    });
  });
});
