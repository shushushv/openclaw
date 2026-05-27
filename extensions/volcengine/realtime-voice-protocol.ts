// Volcengine Doubao Realtime Dialog API binary protocol.
// Endpoint: wss://openspeech.bytedance.com/api/v3/realtime/dialogue
// Reference: Volcengine Doubao Realtime API official documentation.

export const VOLC_REALTIME_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
export const VOLC_REALTIME_RESOURCE_ID = "volc.speech.dialog";
// Fixed value per Volcengine official documentation for X-Api-App-Key header —
// this is a protocol-level identifier, not a user-specific secret.
export const VOLC_REALTIME_FIXED_APP_KEY = "PlgvMymc7f3tQnJ6";

export const VOLC_MSG_TYPE_FULL_CLIENT = 0b0001;
export const VOLC_MSG_TYPE_FULL_SERVER = 0b1001;
export const VOLC_MSG_TYPE_AUDIO_REQUEST = 0b0010;
export const VOLC_MSG_TYPE_AUDIO_RESPONSE = 0b1011;
export const VOLC_MSG_TYPE_ERROR = 0b1111;

export const VOLC_FLAG_NONE = 0b0000;
export const VOLC_FLAG_SEQUENCE_INTERIM = 0b0001;
export const VOLC_FLAG_SEQUENCE_LAST = 0b0010;
export const VOLC_FLAG_SEQUENCE_NEG_LAST = 0b0011;
export const VOLC_FLAG_HAS_EVENT = 0b0100;
export const VOLC_FLAG_ERROR = 0b1111;

export const VOLC_SERIALIZATION_RAW = 0b0000;
export const VOLC_SERIALIZATION_JSON = 0b0001;
export const VOLC_COMPRESSION_NONE = 0b0000;
export const VOLC_COMPRESSION_GZIP = 0b0001;

export const VOLC_EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  StartSession: 100,
  FinishSession: 102,
  TaskRequest: 200,
  UpdateConfig: 201,
  SayHello: 300,
  EndASR: 400,
  ChatTTSText: 500,
  ChatTextQuery: 501,
  ChatRAGText: 502,
  ConversationCreate: 510,
  ConversationUpdate: 511,
  ConversationRetrieve: 512,
  ConversationTruncate: 513,
  ConversationDelete: 514,
  ClientInterrupt: 515,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  ConfigUpdated: 251,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359,
  ASRInfo: 450,
  ASRResponse: 451,
  ASREnded: 459,
  ChatResponse: 550,
  ChatTextQueryConfirmed: 553,
  ChatEnded: 559,
  ConversationCreated: 567,
  ConversationUpdated: 568,
  ConversationRetrieved: 569,
  ConversationTruncated: 570,
  ConversationDeleted: 571,
  DialogCommonError: 599,
} as const;

export type VolcEventId = (typeof VOLC_EVENT)[keyof typeof VOLC_EVENT];

const CONNECT_CLASS_EVENT_IDS = new Set<number>([
  VOLC_EVENT.StartConnection,
  VOLC_EVENT.FinishConnection,
  VOLC_EVENT.ConnectionStarted,
  VOLC_EVENT.ConnectionFailed,
  VOLC_EVENT.ConnectionFinished,
]);

export function isConnectClassEvent(eventId: number | undefined): boolean {
  return typeof eventId === "number" && CONNECT_CLASS_EVENT_IDS.has(eventId);
}

export type VolcEncodeFrameOptions = {
  messageType: number;
  flags?: number;
  serialization?: number;
  compression?: number;
  eventId?: number;
  sessionId?: string;
  sequence?: number;
  code?: number;
  payload?: Buffer | string | Record<string, unknown>;
};

export function encodeVolcFrame(opts: VolcEncodeFrameOptions): Buffer {
  const {
    messageType,
    flags = VOLC_FLAG_NONE,
    serialization = VOLC_SERIALIZATION_JSON,
    compression = VOLC_COMPRESSION_NONE,
    eventId,
    sessionId,
    sequence,
    code,
    payload,
  } = opts;
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload ?? {}), "utf8");
  const parts: Buffer[] = [];
  const header = Buffer.alloc(4);
  header[0] = (0b0001 << 4) | 0b0001;
  header[1] = ((messageType & 0b1111) << 4) | (flags & 0b1111);
  header[2] = ((serialization & 0b1111) << 4) | (compression & 0b1111);
  header[3] = 0;
  parts.push(header);
  if (flags === VOLC_FLAG_ERROR) {
    if (typeof code !== "number") {
      throw new Error("code required for error frame");
    }
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(code >>> 0, 0);
    parts.push(buf);
  }
  if (
    flags === VOLC_FLAG_SEQUENCE_INTERIM ||
    flags === VOLC_FLAG_SEQUENCE_LAST ||
    flags === VOLC_FLAG_SEQUENCE_NEG_LAST
  ) {
    if (typeof sequence !== "number") {
      throw new Error("sequence required for sequence-flagged frame");
    }
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(sequence, 0);
    parts.push(buf);
  }
  if ((flags & VOLC_FLAG_HAS_EVENT) === VOLC_FLAG_HAS_EVENT) {
    if (typeof eventId !== "number") {
      throw new Error("eventId required when FLAG_HAS_EVENT set");
    }
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(eventId, 0);
    parts.push(buf);
  }
  if (sessionId !== undefined) {
    const sidBuf = Buffer.from(sessionId, "utf8");
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(sidBuf.length, 0);
    parts.push(sizeBuf, sidBuf);
  }
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payloadBuf.length, 0);
  parts.push(payloadSize, payloadBuf);
  return Buffer.concat(parts);
}

export type VolcDecodedFrame = {
  version: number;
  headerSize: number;
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  code?: number;
  sequence?: number;
  eventId?: number;
  sessionId?: string;
  payloadBytes: number;
  payloadJson?: unknown;
  payloadText?: string;
  payloadRaw?: Buffer;
};

export function decodeVolcFrame(buf: Buffer): VolcDecodedFrame {
  if (buf.length < 4) {
    throw new Error(`frame too short: ${buf.length}`);
  }
  const version = (buf[0] >> 4) & 0b1111;
  const headerSize = buf[0] & 0b1111;
  const messageType = (buf[1] >> 4) & 0b1111;
  const flags = buf[1] & 0b1111;
  const serialization = (buf[2] >> 4) & 0b1111;
  const compression = buf[2] & 0b1111;
  let cursor = headerSize * 4;
  const out: VolcDecodedFrame = {
    version,
    headerSize,
    messageType,
    flags,
    serialization,
    compression,
    payloadBytes: 0,
  };
  if (messageType === VOLC_MSG_TYPE_ERROR || flags === VOLC_FLAG_ERROR) {
    out.code = buf.readUInt32BE(cursor);
    cursor += 4;
  }
  if (
    flags === VOLC_FLAG_SEQUENCE_INTERIM ||
    flags === VOLC_FLAG_SEQUENCE_LAST ||
    flags === VOLC_FLAG_SEQUENCE_NEG_LAST
  ) {
    out.sequence = buf.readInt32BE(cursor);
    cursor += 4;
  }
  if ((flags & VOLC_FLAG_HAS_EVENT) === VOLC_FLAG_HAS_EVENT) {
    out.eventId = buf.readInt32BE(cursor);
    cursor += 4;
  }
  // Session-class events carry session_id_size + session_id ahead of payload.
  // Error frames (VOLC_FLAG_ERROR) do not include a sessionId even when they have an eventId.
  if (
    out.eventId !== undefined &&
    !isConnectClassEvent(out.eventId) &&
    flags !== VOLC_FLAG_ERROR &&
    cursor + 4 <= buf.length
  ) {
    const sidSize = buf.readUInt32BE(cursor);
    if (sidSize > 0 && sidSize < 1024 && cursor + 4 + sidSize <= buf.length) {
      cursor += 4;
      out.sessionId = buf.slice(cursor, cursor + sidSize).toString("utf8");
      cursor += sidSize;
    }
  }
  if (cursor + 4 <= buf.length) {
    const payloadSize = buf.readUInt32BE(cursor);
    cursor += 4;
    out.payloadBytes = payloadSize;
    if (payloadSize > 0 && cursor + payloadSize <= buf.length) {
      const payload = buf.slice(cursor, cursor + payloadSize);
      if (serialization === VOLC_SERIALIZATION_JSON) {
        const text = payload.toString("utf8");
        try {
          out.payloadJson = JSON.parse(text);
        } catch {
          out.payloadText = text;
        }
      } else {
        out.payloadRaw = payload;
      }
    }
  }
  return out;
}
