import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkEvent,
  RealtimeTalkGatewayRelaySessionResult,
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkSessionResult,
  RealtimeTalkStatus,
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
  RealtimeTalkWebRtcSdpSessionResult,
  VideoCaptureCallback,
  VideoFrame,
  VideoMode,
} from "./realtime-talk-shared.ts";
import { VideoFrameThrottle } from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

export type {
  RealtimeTalkCallbacks,
  RealtimeTalkEvent,
  RealtimeTalkSessionResult,
  RealtimeTalkStatus,
  VideoCaptureCallback,
  VideoFrame,
  VideoMode,
};

export type RealtimeTalkLaunchOptions = {
  provider?: string;
  model?: string;
  voice?: string;
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
  videoEnabled?: boolean;
  videoMode?: VideoMode;
  captureVideoFrame?: VideoCaptureCallback;
};

function createTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  const transport = resolveTransport(session);
  if (transport === "webrtc") {
    return new WebRtcSdpRealtimeTalkTransport(session as RealtimeTalkWebRtcSdpSessionResult, ctx);
  }
  if (transport === "provider-websocket") {
    return new GoogleLiveRealtimeTalkTransport(
      session as RealtimeTalkJsonPcmWebSocketSessionResult,
      ctx,
    );
  }
  if (transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(
      session as RealtimeTalkGatewayRelaySessionResult,
      ctx,
    );
  }
  if (transport === "managed-room") {
    throw new Error("Managed-room realtime Talk sessions are not available in this UI yet");
  }
  const unknownTransport = (session as { transport?: string }).transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}

function resolveTransport(session: RealtimeTalkSessionResult): string {
  return normalizeTalkTransport((session as { transport?: string }).transport) ?? "webrtc";
}

const CLIENT_ONLY_LAUNCH_KEYS = new Set<keyof RealtimeTalkLaunchOptions>([
  "videoEnabled",
  "captureVideoFrame",
]);

function compactLaunchParams(
  params: RealtimeTalkLaunchOptions & { sessionKey: string; mode?: string; brain?: string },
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) =>
        value !== undefined && !CLIENT_ONLY_LAUNCH_KEYS.has(key as keyof RealtimeTalkLaunchOptions),
    ),
  );
}

export class RealtimeTalkSession {
  private transport: RealtimeTalkTransport | null = null;
  private closed = false;
  private activeVideoTimer: ReturnType<typeof setInterval> | null = null;
  private videoInFlight = false;
  private lastVideoFramePromise: Promise<void> | null = null;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
    private readonly options: RealtimeTalkLaunchOptions = {},
  ) {}

  async start(): Promise<void> {
    this.closed = false;
    this.callbacks.onStatus?.("connecting");
    const session = await this.createSession();
    if (this.closed) {
      return;
    }
    this.transport = createTransport(session, {
      client: this.client,
      sessionKey: this.sessionKey,
      callbacks: this.callbacks,
      consultThinkingLevel: session.consultThinkingLevel,
      consultFastMode: session.consultFastMode,
      videoEnabled: this.options.videoEnabled,
      videoMode: this.options.videoMode,
      captureVideoFrame: this.options.captureVideoFrame,
    });
    if (
      this.options.videoEnabled &&
      this.options.videoMode &&
      this.transport.supportsVideoMode?.(this.options.videoMode) === false
    ) {
      const transport = resolveTransport(session);
      const message = `Video mode "${this.options.videoMode}" is not supported for ${session.provider} ${transport}. Please choose a supported video mode or start audio-only Talk.`;
      this.transport.stop();
      this.transport = null;
      throw new Error(message);
    }
    await this.transport.start();
    if (this.options.videoMode === "active" && this.options.captureVideoFrame) {
      this.startActiveVideoTimer();
    }
  }

  private startActiveVideoTimer(): void {
    const throttle = new VideoFrameThrottle(1);
    this.activeVideoTimer = setInterval(() => {
      void this.tickActiveVideo(throttle);
    }, throttle.intervalMs);
  }

  private async tickActiveVideo(throttle: VideoFrameThrottle): Promise<void> {
    if (
      this.videoInFlight ||
      !this.transport?.appendVideoFrame ||
      !this.options.captureVideoFrame
    ) {
      return;
    }
    this.videoInFlight = true;
    const framePromise = (async () => {
      try {
        const frame = await this.options.captureVideoFrame!();
        if (!frame || throttle.shouldSkip(frame) || !this.transport?.appendVideoFrame) {
          return;
        }
        await this.transport.appendVideoFrame(frame);
      } catch {
        // appendVideoFrame failed (e.g. provider returned unsupported); stop the timer
        // so we don't spam errors every second. Voice continues uninterrupted.
        if (this.activeVideoTimer !== null) {
          clearInterval(this.activeVideoTimer);
          this.activeVideoTimer = null;
        }
      } finally {
        this.videoInFlight = false;
      }
    })();
    this.lastVideoFramePromise = framePromise;
    await framePromise;
  }

  private async createSession(): Promise<RealtimeTalkSessionResult> {
    try {
      return await this.client.request<RealtimeTalkSessionResult>(
        "talk.client.create",
        compactLaunchParams({
          sessionKey: this.sessionKey,
          ...this.options,
        }),
      );
    } catch (error) {
      if (this.options.transport && this.options.transport !== "gateway-relay") {
        throw error;
      }
      try {
        return await this.client.request<RealtimeTalkSessionResult>(
          "talk.session.create",
          compactLaunchParams({
            sessionKey: this.sessionKey,
            ...this.options,
            mode: "realtime",
            transport: this.options.transport ?? "gateway-relay",
            brain: "agent-consult",
          }),
        );
      } catch {
        throw error;
      }
    }
  }

  stop(): void {
    this.closed = true;
    // Stop the active video timer first so no new frames are dispatched.
    if (this.activeVideoTimer !== null) {
      clearInterval(this.activeVideoTimer);
      this.activeVideoTimer = null;
    }
    this.callbacks.onStatus?.("idle");
    // Best-effort wait for the in-flight frame (short timeout to avoid blocking stop).
    const lastFrame = this.lastVideoFramePromise;
    this.lastVideoFramePromise = null;
    if (lastFrame) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
      void Promise.race([lastFrame, timeout]).finally(() => {
        this.transport?.stop();
        this.transport = null;
      });
    } else {
      this.transport?.stop();
      this.transport = null;
    }
  }
}
