// Realtime Talk client-side trace instrumentation.
// This file is debug/observability only — keep separate from transport logic.

export function talkTrace(
  sessionKey: string,
  provider: string,
  event: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ __talkTrace: true, t: Date.now(), sessionKey, provider, ...event }));
}

/** Per-turn TTFT / Total RTT tracker for Google Live (provider-websocket) transport. */
export class TalkGoogleLiveTracer {
  private lastToolResponseSentAt: number | null = null;
  private lastToolResponseCallId: string | null = null;
  private turnFirstDeltaEmitted = false;
  private turnFirstAudioEmitted = false;

  constructor(private readonly sessionKey: string) {}

  private trace(event: Record<string, unknown>): void {
    talkTrace(this.sessionKey, "google", event);
  }

  onConnecting(model?: string, transport?: string, videoMode?: string): void {
    this.trace({ type: "ws.connecting", model, transport, videoMode });
  }

  onWsOpen(): void {
    this.trace({ type: "ws.open" });
  }

  onWsSetupSent(): void {
    this.trace({ type: "ws.setup_sent" });
  }

  onWsClose(code: number, wasClean: boolean): void {
    this.trace({ type: "ws.close", code, clean: wasClean });
  }

  onWsError(): void {
    this.trace({ type: "ws.error" });
  }

  onSessionStop(): void {
    this.trace({ type: "session.stop" });
  }

  onSessionReady(): void {
    this.trace({ type: "session.ready" });
  }

  onOutputTextDelta(): void {
    if (!this.turnFirstDeltaEmitted && this.lastToolResponseSentAt !== null) {
      this.turnFirstDeltaEmitted = true;
      this.trace({
        type: "output.text.first_delta",
        ttftMs: Date.now() - this.lastToolResponseSentAt,
        refCallId: this.lastToolResponseCallId,
      });
    }
  }

  onTurnComplete(): void {
    if (this.lastToolResponseSentAt !== null) {
      this.trace({
        type: "turn.complete",
        totalRttMs: Date.now() - this.lastToolResponseSentAt,
        refCallId: this.lastToolResponseCallId,
      });
      this.lastToolResponseSentAt = null;
      this.lastToolResponseCallId = null;
    }
    this.turnFirstDeltaEmitted = false;
    this.turnFirstAudioEmitted = false;
  }

  onAudioChunk(): void {
    if (!this.turnFirstAudioEmitted && this.lastToolResponseSentAt !== null) {
      this.turnFirstAudioEmitted = true;
      this.trace({
        type: "audio.first_chunk",
        audioTtftMs: Date.now() - this.lastToolResponseSentAt,
        refCallId: this.lastToolResponseCallId,
      });
    }
  }

  onToolCall(name: string, callId: string): void {
    this.trace({ type: "tool.call.received", name, callId });
  }

  onAgentConsultStarted(callId: string): number {
    this.trace({ type: "agent_consult.started", callId });
    return Date.now();
  }

  onAgentConsultCompleted(callId: string, startedAt: number): void {
    this.trace({ type: "agent_consult.completed", callId, durationMs: Date.now() - startedAt });
  }

  onVideoFrameSent(sizeBytes: number, mimeType: string): void {
    this.trace({ type: "video.frame_sent", sizeBytes, mimeType });
  }

  onDescribeViewCaptured(
    callId: string,
    captureMs: number,
    sizeBytes: number,
    mimeType: string,
  ): void {
    this.trace({ type: "describe_view.frame_captured", callId, captureMs, sizeBytes, mimeType });
  }

  onDescribeViewUnavailable(callId: string): void {
    this.trace({ type: "describe_view.camera_unavailable", callId });
  }

  /** Sets timing baseline for TTFT/RTT and emits describe_view.response_sent. */
  onDescribeViewSent(callId: string): void {
    this.lastToolResponseSentAt = Date.now();
    this.lastToolResponseCallId = callId;
    this.turnFirstDeltaEmitted = false;
    this.turnFirstAudioEmitted = false;
    this.trace({ type: "describe_view.response_sent", callId });
  }
}

/** Per-turn Total RTT tracker for WebRTC (provider-websocket / webrtc) transport.
 * Audio arrives via media track so audio TTFT is not measurable here;
 * totalRttMs is measured from speech_stopped (VAD turn) or describe_view.response_sent. */
export class TalkWebRtcTracer {
  private turnStartedAt: number | null = null;
  private turnRefCallId: string | null = null;

  constructor(
    private readonly sessionKey: string,
    private readonly provider: string,
  ) {}

  private trace(event: Record<string, unknown>): void {
    talkTrace(this.sessionKey, this.provider, event);
  }

  onConnecting(model?: string, videoMode?: string): void {
    this.trace({ type: "ws.connecting", model, transport: "webrtc", videoMode });
  }

  onSessionReady(): void {
    this.trace({ type: "session.ready" });
  }

  onSessionStop(): void {
    this.trace({ type: "session.stop" });
  }

  onSpeechStopped(): void {
    this.turnStartedAt = Date.now();
    this.turnRefCallId = null;
  }

  onResponseDone(): void {
    if (this.turnStartedAt !== null) {
      this.trace({
        type: "turn.complete",
        totalRttMs: Date.now() - this.turnStartedAt,
        refCallId: this.turnRefCallId,
      });
      this.turnStartedAt = null;
      this.turnRefCallId = null;
    }
  }

  onToolCall(name: string, callId: string): void {
    this.trace({ type: "tool.call.received", name, callId });
  }

  onDescribeViewCaptured(
    callId: string,
    captureMs: number,
    sizeBytes: number,
    mimeType: string,
  ): void {
    this.trace({ type: "describe_view.frame_captured", callId, captureMs, sizeBytes, mimeType });
  }

  onDescribeViewUnavailable(callId: string): void {
    this.trace({ type: "describe_view.camera_unavailable", callId });
  }

  onDescribeViewSent(callId: string): void {
    this.turnStartedAt = Date.now();
    this.turnRefCallId = callId;
    this.trace({ type: "describe_view.response_sent", callId });
  }

  onAgentConsultStarted(callId: string): number {
    this.trace({ type: "agent_consult.started", callId });
    return Date.now();
  }

  onAgentConsultCompleted(callId: string, startedAt: number): void {
    this.trace({ type: "agent_consult.completed", callId, durationMs: Date.now() - startedAt });
  }

  onVideoFrameSent(sizeBytes: number, mimeType: string): void {
    this.trace({ type: "video.frame_sent", sizeBytes, mimeType });
  }
}

/** Per-turn TTFT / Total RTT tracker for gateway-relay transport. */
export class TalkRelayTracer {
  private turnStartedAt: number | null = null;
  private firstAudioInTurn = true;
  private turnRefCallId: string | null = null;

  constructor(
    private readonly sessionKey: string,
    private readonly provider: string,
  ) {}

  onConnecting(model?: string, videoMode?: string): void {
    talkTrace(this.sessionKey, this.provider, {
      type: "ws.connecting",
      model,
      transport: "gateway-relay",
      videoMode,
    });
  }

  onReady(): void {
    talkTrace(this.sessionKey, this.provider, { type: "session.ready" });
  }

  onUserTranscriptFinal(): void {
    this.turnStartedAt = Date.now();
    this.firstAudioInTurn = true;
    this.turnRefCallId = null;
  }

  onAudioChunk(): void {
    if (this.firstAudioInTurn) {
      const audioTtftMs = this.turnStartedAt !== null ? Date.now() - this.turnStartedAt : undefined;
      talkTrace(this.sessionKey, this.provider, {
        type: "audio.first_chunk",
        audioTtftMs,
        refCallId: this.turnRefCallId,
      });
      this.firstAudioInTurn = false;
    }
  }

  onAudioDone(): void {
    if (this.turnStartedAt !== null) {
      talkTrace(this.sessionKey, this.provider, {
        type: "turn.complete",
        totalRttMs: Date.now() - this.turnStartedAt,
        refCallId: this.turnRefCallId,
      });
      this.turnStartedAt = null;
      this.firstAudioInTurn = true;
      this.turnRefCallId = null;
    }
  }

  onToolCall(name?: string, callId?: string): void {
    talkTrace(this.sessionKey, this.provider, { type: "tool.call.received", name, callId });
  }

  onAgentConsultStarted(callId: string): number {
    talkTrace(this.sessionKey, this.provider, { type: "agent_consult.started", callId });
    return Date.now();
  }

  onAgentConsultCompleted(callId: string, startedAt: number): void {
    talkTrace(this.sessionKey, this.provider, {
      type: "agent_consult.completed",
      callId,
      durationMs: Date.now() - startedAt,
    });
  }

  onVideoFrameSent(sizeBytes: number, mimeType: string): void {
    talkTrace(this.sessionKey, this.provider, { type: "video.frame_sent", sizeBytes, mimeType });
  }

  onDescribeViewCaptured(
    callId: string,
    captureMs: number,
    sizeBytes: number,
    mimeType: string,
  ): void {
    talkTrace(this.sessionKey, this.provider, {
      type: "describe_view.frame_captured",
      callId,
      captureMs,
      sizeBytes,
      mimeType,
    });
  }

  onDescribeViewUnavailable(callId: string): void {
    talkTrace(this.sessionKey, this.provider, { type: "describe_view.camera_unavailable", callId });
  }

  onDescribeViewSent(callId: string): void {
    this.turnStartedAt = Date.now();
    this.firstAudioInTurn = true;
    this.turnRefCallId = callId;
    talkTrace(this.sessionKey, this.provider, { type: "describe_view.response_sent", callId });
  }

  onClose(reason?: string): void {
    talkTrace(this.sessionKey, this.provider, { type: "session.stop", reason });
  }
}
