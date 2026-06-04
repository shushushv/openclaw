// @vitest-environment node
import { describe, expect, it } from "vitest";
import { videoModeSupported } from "./realtime-talk-shared.ts";

describe("videoModeSupported", () => {
  it.each([
    ["openai", "webrtc", "passive"],
    ["openai", "webrtc", "active"],
    ["openai", "gateway-relay", "passive"],
    ["openai", "gateway-relay", "active"],
    ["google", "provider-websocket", "passive"],
    ["google", "provider-websocket", "active"],
    ["google", "gateway-relay", "passive"],
    ["google", "gateway-relay", "active"],
  ] as const)("returns true for %s + %s + %s", (provider, transport, mode) => {
    expect(videoModeSupported(provider, transport, mode)).toBe(true);
  });

  it.each([
    ["openai", "provider-websocket", "passive"],
    ["openai", "provider-websocket", "active"],
    ["google", "webrtc", "passive"],
    ["google", "webrtc", "active"],
    ["openai", "managed-room", "passive"],
    ["google", "managed-room", "active"],
    ["unknown", "webrtc", "passive"],
    ["unknown", "gateway-relay", "active"],
  ] as const)("returns false for %s + %s + %s", (provider, transport, mode) => {
    expect(videoModeSupported(provider, transport, mode)).toBe(false);
  });
});
