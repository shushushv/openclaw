import { floatToPcm16, pcm16ToFloat } from "./realtime-talk-audio.ts";
import type { RealtimeTalkJsonPcmWebSocketSessionResult } from "./realtime-talk-shared.ts";
import {
  createRealtimeTalkEventEmitter,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

// JSON control messages sent as text frames from the proxy/provider.
// Binary frames carry raw PCM16 audio to play back.
type PcmBinaryControlMessage = {
  type: string;
  role?: "user" | "assistant";
  text?: string;
  reason?: string;
  message?: string;
};

export class PcmBinaryWebSocketRealtimeTalkTransport implements RealtimeTalkTransport {
  private ws: WebSocket | null = null;
  private media: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private closed = false;
  private outputPlayhead = 0;
  private readonly outputSources = new Set<AudioBufferSourceNode>();
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;

  constructor(
    private readonly session: RealtimeTalkJsonPcmWebSocketSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof WebSocket === "undefined") {
      throw new Error("Realtime Talk requires browser WebSocket and microphone access");
    }
    this.closed = false;
    this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.inputContext = new AudioContext({ sampleRate: this.session.audio.inputSampleRateHz });
    this.outputContext = new AudioContext({ sampleRate: this.session.audio.outputSampleRateHz });
    this.ws = new WebSocket(this.session.websocketUrl);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      if (this.closed) {
        return;
      }
      this.ctx.callbacks.onStatus?.("listening");
      this.emitTalkEvent({ type: "session.ready" });
      this.startMicrophonePump();
    });
    this.ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    this.ws.addEventListener("close", () => {
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("error", "Realtime connection closed");
      }
    });
    this.ws.addEventListener("error", () => {
      if (!this.closed) {
        this.ctx.callbacks.onStatus?.("error", "Realtime connection failed");
      }
    });
  }

  stop(): void {
    if (!this.closed) {
      this.emitTalkEvent({ type: "session.closed", final: true });
    }
    this.closed = true;
    this.inputProcessor?.disconnect();
    this.inputProcessor = null;
    this.inputSource?.disconnect();
    this.inputSource = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.stopOutput();
    void this.inputContext?.close();
    this.inputContext = null;
    void this.outputContext?.close();
    this.outputContext = null;
    this.ws?.close();
    this.ws = null;
  }

  private startMicrophonePump(): void {
    if (this.closed || !this.media || !this.inputContext) {
      return;
    }
    this.inputSource = this.inputContext.createMediaStreamSource(this.media);
    this.inputProcessor = this.inputContext.createScriptProcessor(4096, 1, 1);
    this.inputProcessor.onaudioprocess = (event) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
      // floatToPcm16 always allocates via new Uint8Array(), so buffer is ArrayBuffer.
      this.ws.send(pcm.buffer as ArrayBuffer);
    };
    this.inputSource.connect(this.inputProcessor);
    this.inputProcessor.connect(this.inputContext.destination);
  }

  private handleMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.playPcm16(new Uint8Array(data));
      return;
    }
    if (typeof data === "string") {
      let msg: PcmBinaryControlMessage;
      try {
        msg = JSON.parse(data) as PcmBinaryControlMessage;
      } catch {
        return;
      }
      this.handleControlMessage(msg);
    }
  }

  private handleControlMessage(msg: PcmBinaryControlMessage): void {
    switch (msg.type) {
      case "transcript.delta":
      case "transcript.done": {
        const final = msg.type === "transcript.done";
        const role = msg.role ?? "user";
        const text = msg.text ?? "";
        if (text) {
          this.ctx.callbacks.onTranscript?.({ role, text, final });
          this.emitTalkEvent({
            type: final ? "transcript.done" : "transcript.delta",
            final,
            payload: { role, text },
          });
        }
        break;
      }
      case "output.text.delta": {
        const text = msg.text ?? "";
        if (text) {
          this.ctx.callbacks.onTranscript?.({ role: "assistant", text, final: false });
          this.emitTalkEvent({ type: "output.text.delta", payload: { text } });
        }
        break;
      }
      case "output.text.done": {
        const text = msg.text ?? "";
        this.ctx.callbacks.onTranscript?.({ role: "assistant", text, final: true });
        this.emitTalkEvent({ type: "output.text.done", final: true, payload: { text } });
        break;
      }
      case "turn.started":
        this.emitTalkEvent({ type: "turn.started" });
        break;
      case "turn.ended":
        this.emitTalkEvent({ type: "turn.ended", final: true });
        break;
      case "turn.cancelled":
        this.stopOutput();
        this.emitTalkEvent({
          type: "turn.cancelled",
          final: true,
          payload: { reason: msg.reason ?? "provider-interrupted" },
        });
        break;
      case "output.audio.started":
        this.emitTalkEvent({ type: "output.audio.started" });
        break;
      case "output.audio.done":
        this.emitTalkEvent({ type: "output.audio.done", final: true });
        break;
      case "error":
        if (!this.closed) {
          this.ctx.callbacks.onStatus?.("error", msg.message ?? "Provider error");
        }
        break;
    }
  }

  private playPcm16(bytes: Uint8Array): void {
    if (!this.outputContext) {
      return;
    }
    const samples = pcm16ToFloat(bytes);
    if (samples.length === 0) {
      return;
    }
    const buffer = this.outputContext.createBuffer(
      1,
      samples.length,
      this.session.audio.outputSampleRateHz,
    );
    buffer.getChannelData(0).set(samples);
    const source = this.outputContext.createBufferSource();
    this.outputSources.add(source);
    source.addEventListener("ended", () => this.outputSources.delete(source));
    source.buffer = buffer;
    source.connect(this.outputContext.destination);
    const startAt = Math.max(this.outputContext.currentTime, this.outputPlayhead);
    source.start(startAt);
    this.outputPlayhead = startAt + buffer.duration;
    this.emitTalkEvent({
      type: "output.audio.delta",
      payload: { byteLength: bytes.byteLength },
    });
  }

  private stopOutput(): void {
    for (const source of this.outputSources) {
      try {
        source.stop();
      } catch {}
    }
    this.outputSources.clear();
    this.outputPlayhead = this.outputContext?.currentTime ?? 0;
  }
}
