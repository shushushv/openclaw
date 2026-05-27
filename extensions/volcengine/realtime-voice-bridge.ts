import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "ws";

const log = createSubsystemLogger("volc-realtime");
import {
  VOLC_COMPRESSION_NONE,
  VOLC_EVENT,
  VOLC_FLAG_HAS_EVENT,
  VOLC_FLAG_NONE,
  VOLC_MSG_TYPE_AUDIO_REQUEST,
  VOLC_MSG_TYPE_FULL_CLIENT,
  VOLC_REALTIME_ENDPOINT,
  VOLC_REALTIME_FIXED_APP_KEY,
  VOLC_REALTIME_RESOURCE_ID,
  VOLC_SERIALIZATION_JSON,
  VOLC_SERIALIZATION_RAW,
  decodeVolcFrame,
  encodeVolcFrame,
} from "./realtime-voice-protocol.js";

const INPUT_SAMPLE_RATE_HZ = 24000;
const VOLC_INPUT_SAMPLE_RATE_HZ = 16000;
const VOLC_OUTPUT_SAMPLE_RATE_HZ = 24000;
const DEFAULT_MODEL = "1.2.1.1";
const DEFAULT_SPEAKER = "zh_female_vv_jupiter_bigtts";

export type VolcRealtimeBridgeParams = RealtimeVoiceBridgeCreateRequest & {
  appId: string;
  accessKey: string;
  model?: string;
  speaker?: string;
};

export function createVolcRealtimeBridge(params: VolcRealtimeBridgeParams): RealtimeVoiceBridge {
  const sessionId = randomUUID();
  let ws: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let connectResolve: (() => void) | null = null;
  let connectReject: ((err: Error) => void) | null = null;
  let connectionStarted = false;
  let sessionStarted = false;

  const emitEvent = (direction: "client" | "server", type: string, detail?: string): void => {
    params.onEvent?.({ direction, type, ...(detail !== undefined ? { detail } : {}) });
  };

  const send = (buf: Buffer, type: string): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(buf);
    emitEvent("client", type);
  };

  const sendJsonEvent = (
    eventId: number,
    payload: Record<string, unknown> | undefined,
    includeSessionId: boolean,
    type: string,
  ): void => {
    const frame = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_FULL_CLIENT,
      flags: VOLC_FLAG_HAS_EVENT,
      serialization: VOLC_SERIALIZATION_JSON,
      compression: VOLC_COMPRESSION_NONE,
      eventId,
      ...(includeSessionId ? { sessionId } : {}),
      payload: payload ?? {},
    });
    send(frame, type);
  };

  const sendStartConnection = (): void => {
    sendJsonEvent(VOLC_EVENT.StartConnection, {}, false, "StartConnection");
  };

  const sendStartSession = (): void => {
    const startPayload: Record<string, unknown> = {
      tts: {
        audio_config: {
          channel: 1,
          format: "pcm_s16le",
          sample_rate: VOLC_OUTPUT_SAMPLE_RATE_HZ,
        },
        speaker: params.speaker ?? DEFAULT_SPEAKER,
      },
      dialog: {
        extra: {
          input_mod: "keep_alive",
          model: params.model ?? DEFAULT_MODEL,
        },
      },
    };
    if (params.instructions) {
      (startPayload.dialog as Record<string, unknown>).system_role = params.instructions;
    }
    sendJsonEvent(VOLC_EVENT.StartSession, startPayload, true, "StartSession");
  };

  const sendFinishSession = (): void => {
    sendJsonEvent(VOLC_EVENT.FinishSession, {}, true, "FinishSession");
  };

  const sendFinishConnection = (): void => {
    sendJsonEvent(VOLC_EVENT.FinishConnection, {}, false, "FinishConnection");
  };

  const handleServerFrame = (buf: Buffer): void => {
    let frame;
    try {
      frame = decodeVolcFrame(buf);
    } catch (err) {
      params.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const eventName = frame.eventId !== undefined ? `event-${frame.eventId}` : "no-event";
    emitEvent("server", eventName);
    switch (frame.eventId) {
      case VOLC_EVENT.ConnectionStarted:
        connectionStarted = true;
        log.info(`ConnectionStarted, sending StartSession session_id=${sessionId}`);
        sendStartSession();
        return;
      case VOLC_EVENT.ConnectionFailed: {
        const msg =
          (frame.payloadJson as { error?: string } | undefined)?.error ?? "connection failed";
        log.warn(`ConnectionFailed: ${msg}`);
        params.onError?.(new Error(`Volc ConnectionFailed: ${msg}`));
        if (connectReject) {
          connectReject(new Error(msg));
          connectReject = null;
          connectResolve = null;
        }
        return;
      }
      case VOLC_EVENT.SessionStarted:
        sessionStarted = true;
        log.info(`SessionStarted, bridge ready`);
        if (connectResolve) {
          connectResolve();
          connectResolve = null;
          connectReject = null;
        }
        params.onReady?.();
        return;
      case VOLC_EVENT.SessionFailed: {
        const msg =
          (frame.payloadJson as { error?: string } | undefined)?.error ?? "session failed";
        params.onError?.(new Error(`Volc SessionFailed: ${msg}`));
        if (connectReject) {
          connectReject(new Error(msg));
          connectReject = null;
          connectResolve = null;
        }
        return;
      }
      case VOLC_EVENT.ASRInfo:
        params.onClearAudio();
        return;
      case VOLC_EVENT.ASRResponse: {
        const payload = frame.payloadJson as
          | { results?: Array<{ text?: string; is_interim?: boolean }> }
          | undefined;
        const first = payload?.results?.[0];
        if (first?.text) {
          params.onTranscript?.("user", first.text, first.is_interim === false);
        }
        return;
      }
      case VOLC_EVENT.ChatResponse: {
        const payload = frame.payloadJson as { content?: string } | undefined;
        if (payload?.content) {
          params.onTranscript?.("assistant", payload.content, false);
        }
        return;
      }
      case VOLC_EVENT.ChatEnded:
        params.onTranscript?.("assistant", "", true);
        return;
      case VOLC_EVENT.TTSResponse:
        if (frame.payloadRaw && frame.payloadRaw.length > 0) {
          params.onAudio(frame.payloadRaw);
        }
        return;
      case VOLC_EVENT.SessionFinished:
        sessionStarted = false;
        return;
      case VOLC_EVENT.ConnectionFinished:
        connectionStarted = false;
        if (!closed) {
          closeInternal("completed");
        }
        return;
      case VOLC_EVENT.DialogCommonError: {
        const payload = frame.payloadJson as { status_code?: string; message?: string } | undefined;
        const msg = `${payload?.status_code ?? "error"}: ${payload?.message ?? ""}`.trim();
        params.onError?.(new Error(`Volc DialogCommonError: ${msg}`));
        return;
      }
      default:
        return;
    }
  };

  const closeInternal = (reason: "completed" | "error" | "client" | "remote"): void => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      ws?.close();
    } catch {
      // ignore
    }
    ws = null;
    params.onClose?.(reason);
  };

  const bridge: RealtimeVoiceBridge = {
    async connect(): Promise<void> {
      if (closed) {
        throw new Error("bridge already closed");
      }
      const connectId = randomUUID();
      ws = new WebSocket(VOLC_REALTIME_ENDPOINT, {
        headers: {
          "X-Api-App-ID": params.appId,
          "X-Api-Access-Key": params.accessKey,
          "X-Api-Resource-Id": VOLC_REALTIME_RESOURCE_ID,
          "X-Api-App-Key": VOLC_REALTIME_FIXED_APP_KEY,
          "X-Api-Connect-Id": connectId,
        },
      });
      const promise = new Promise<void>((resolve, reject) => {
        connectResolve = resolve;
        connectReject = reject;
      });
      log.info(
        `connecting to ${VOLC_REALTIME_ENDPOINT} appId=${params.appId} connectId=${connectId}`,
      );
      ws.on("open", () => {
        connected = true;
        log.info(`ws open, sending StartConnection`);
        sendStartConnection();
      });
      ws.on("message", (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        handleServerFrame(buf);
      });
      ws.on("error", (err) => {
        log.warn(`ws error: ${err instanceof Error ? err.message : String(err)}`);
        params.onError?.(err instanceof Error ? err : new Error(String(err)));
        if (connectReject) {
          connectReject(err instanceof Error ? err : new Error(String(err)));
          connectReject = null;
          connectResolve = null;
        }
      });
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => {
          log.warn(`ws unexpected-response status=${res.statusCode} body=${body.slice(0, 300)}`);
          const err = new Error(`Volc realtime HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
          params.onError?.(err);
          if (connectReject) {
            connectReject(err);
            connectReject = null;
            connectResolve = null;
          }
        });
      });
      ws.on("close", (code) => {
        log.info(
          `ws close code=${code} sessionStarted=${sessionStarted} connectionStarted=${connectionStarted}`,
        );
        if (!closed) {
          closeInternal(sessionStarted || connectionStarted ? "remote" : "error");
        }
      });
      return promise;
    },
    sendAudio(audio: Buffer): void {
      if (!sessionStarted || !ws || ws.readyState !== WebSocket.OPEN) {
        log.debug(
          `sendAudio dropped: sessionStarted=${sessionStarted} wsState=${ws?.readyState ?? "null"} bytes=${audio.length}`,
        );
        return;
      }
      const resampled = resamplePcm(audio, INPUT_SAMPLE_RATE_HZ, VOLC_INPUT_SAMPLE_RATE_HZ);
      if (resampled.length === 0) {
        return;
      }
      const frame = encodeVolcFrame({
        messageType: VOLC_MSG_TYPE_AUDIO_REQUEST,
        flags: VOLC_FLAG_HAS_EVENT,
        serialization: VOLC_SERIALIZATION_RAW,
        compression: VOLC_COMPRESSION_NONE,
        eventId: VOLC_EVENT.TaskRequest,
        sessionId,
        payload: resampled,
      });
      send(frame, "TaskRequest");
    },
    setMediaTimestamp(_ts: number): void {
      // No-op for Volcengine; server tracks its own timestamps.
    },
    submitToolResult(_callId: string, _result: unknown): void {
      // Volcengine Realtime API has no native function calling in v1 of this bridge.
    },
    acknowledgeMark(): void {
      // No-op; Volcengine does not use mark/ack signals.
    },
    close(): void {
      if (closed) {
        return;
      }
      if (sessionStarted) {
        sendFinishSession();
      }
      if (connectionStarted) {
        sendFinishConnection();
      }
      setTimeout(() => closeInternal("client"), 200);
    },
    isConnected(): boolean {
      return connected && !closed;
    },
  };
  return bridge;
}
