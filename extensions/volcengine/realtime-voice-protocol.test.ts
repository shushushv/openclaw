import { describe, expect, it } from "vitest";
import {
  VOLC_COMPRESSION_NONE,
  VOLC_EVENT,
  VOLC_FLAG_ERROR,
  VOLC_FLAG_HAS_EVENT,
  VOLC_FLAG_NONE,
  VOLC_FLAG_SEQUENCE_LAST,
  VOLC_MSG_TYPE_AUDIO_REQUEST,
  VOLC_MSG_TYPE_FULL_CLIENT,
  VOLC_SERIALIZATION_JSON,
  VOLC_SERIALIZATION_RAW,
  decodeVolcFrame,
  encodeVolcFrame,
  isConnectClassEvent,
} from "./realtime-voice-protocol.js";

describe("encodeVolcFrame / decodeVolcFrame", () => {
  it("roundtrips a basic JSON event frame", () => {
    const payload = { foo: "bar", n: 42 };
    const buf = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_FULL_CLIENT,
      flags: VOLC_FLAG_HAS_EVENT,
      serialization: VOLC_SERIALIZATION_JSON,
      compression: VOLC_COMPRESSION_NONE,
      eventId: VOLC_EVENT.StartConnection,
      payload,
    });
    const frame = decodeVolcFrame(buf);
    expect(frame.messageType).toBe(VOLC_MSG_TYPE_FULL_CLIENT);
    expect(frame.flags).toBe(VOLC_FLAG_HAS_EVENT);
    expect(frame.serialization).toBe(VOLC_SERIALIZATION_JSON);
    expect(frame.compression).toBe(VOLC_COMPRESSION_NONE);
    expect(frame.eventId).toBe(VOLC_EVENT.StartConnection);
    expect(frame.payloadJson).toEqual(payload);
  });

  it("roundtrips a session-scoped event with sessionId", () => {
    const sid = "test-session-123";
    const buf = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_FULL_CLIENT,
      flags: VOLC_FLAG_HAS_EVENT,
      serialization: VOLC_SERIALIZATION_JSON,
      compression: VOLC_COMPRESSION_NONE,
      eventId: VOLC_EVENT.StartSession,
      sessionId: sid,
      payload: { tts: {} },
    });
    const frame = decodeVolcFrame(buf);
    expect(frame.eventId).toBe(VOLC_EVENT.StartSession);
    expect(frame.sessionId).toBe(sid);
    expect(frame.payloadJson).toEqual({ tts: {} });
  });

  it("roundtrips a raw audio frame", () => {
    const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const buf = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_AUDIO_REQUEST,
      flags: VOLC_FLAG_HAS_EVENT,
      serialization: VOLC_SERIALIZATION_RAW,
      compression: VOLC_COMPRESSION_NONE,
      eventId: VOLC_EVENT.TaskRequest,
      sessionId: "audio-session",
      payload: audioData,
    });
    const frame = decodeVolcFrame(buf);
    expect(frame.messageType).toBe(VOLC_MSG_TYPE_AUDIO_REQUEST);
    expect(frame.serialization).toBe(VOLC_SERIALIZATION_RAW);
    expect(frame.payloadRaw).toBeDefined();
    expect(Buffer.compare(frame.payloadRaw!, audioData)).toBe(0);
  });

  it("roundtrips a sequence-flagged frame", () => {
    const buf = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_FULL_CLIENT,
      flags: VOLC_FLAG_SEQUENCE_LAST,
      serialization: VOLC_SERIALIZATION_JSON,
      compression: VOLC_COMPRESSION_NONE,
      sequence: 7,
      payload: {},
    });
    const frame = decodeVolcFrame(buf);
    expect(frame.flags).toBe(VOLC_FLAG_SEQUENCE_LAST);
    expect(frame.sequence).toBe(7);
  });

  it("roundtrips a frame with no payload (empty object)", () => {
    const buf = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_FULL_CLIENT,
      flags: VOLC_FLAG_NONE,
      serialization: VOLC_SERIALIZATION_JSON,
      compression: VOLC_COMPRESSION_NONE,
    });
    const frame = decodeVolcFrame(buf);
    expect(frame.flags).toBe(VOLC_FLAG_NONE);
    expect(frame.payloadJson).toEqual({});
  });

  it("encodes error frame and decodes code field", () => {
    const buf = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_FULL_CLIENT,
      flags: VOLC_FLAG_ERROR,
      serialization: VOLC_SERIALIZATION_JSON,
      compression: VOLC_COMPRESSION_NONE,
      code: 4001,
      // VOLC_FLAG_ERROR (0b1111) has the HAS_EVENT bit set, so eventId is required.
      eventId: VOLC_EVENT.DialogCommonError,
      payload: { message: "bad request" },
    });
    const frame = decodeVolcFrame(buf);
    expect(frame.flags).toBe(VOLC_FLAG_ERROR);
    expect(frame.code).toBe(4001);
    expect(frame.eventId).toBe(VOLC_EVENT.DialogCommonError);
    expect((frame.payloadJson as { message?: string })?.message).toBe("bad request");
  });

  it("throws when buffer is too short", () => {
    expect(() => decodeVolcFrame(Buffer.from([0x11, 0x10]))).toThrow("frame too short");
  });

  it("throws when error frame missing code", () => {
    expect(() =>
      encodeVolcFrame({
        messageType: VOLC_MSG_TYPE_FULL_CLIENT,
        flags: VOLC_FLAG_ERROR,
        serialization: VOLC_SERIALIZATION_JSON,
        compression: VOLC_COMPRESSION_NONE,
        payload: {},
      }),
    ).toThrow("code required");
  });

  it("encodes UTF-8 payload correctly", () => {
    const buf = encodeVolcFrame({
      messageType: VOLC_MSG_TYPE_FULL_CLIENT,
      flags: VOLC_FLAG_NONE,
      serialization: VOLC_SERIALIZATION_JSON,
      compression: VOLC_COMPRESSION_NONE,
      payload: { text: "你好世界" },
    });
    const frame = decodeVolcFrame(buf);
    expect((frame.payloadJson as { text?: string })?.text).toBe("你好世界");
  });
});

describe("isConnectClassEvent", () => {
  it("returns true for connect-class events", () => {
    expect(isConnectClassEvent(VOLC_EVENT.StartConnection)).toBe(true);
    expect(isConnectClassEvent(VOLC_EVENT.FinishConnection)).toBe(true);
    expect(isConnectClassEvent(VOLC_EVENT.ConnectionStarted)).toBe(true);
    expect(isConnectClassEvent(VOLC_EVENT.ConnectionFailed)).toBe(true);
    expect(isConnectClassEvent(VOLC_EVENT.ConnectionFinished)).toBe(true);
  });

  it("returns false for session/dialog events", () => {
    expect(isConnectClassEvent(VOLC_EVENT.StartSession)).toBe(false);
    expect(isConnectClassEvent(VOLC_EVENT.SessionStarted)).toBe(false);
    expect(isConnectClassEvent(VOLC_EVENT.TTSResponse)).toBe(false);
    expect(isConnectClassEvent(VOLC_EVENT.ASRResponse)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isConnectClassEvent(undefined)).toBe(false);
  });
});
