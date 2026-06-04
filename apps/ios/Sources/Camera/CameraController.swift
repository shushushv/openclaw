import AVFoundation
import Foundation
import OpenClawKit
import os

/// AVCapturePhotoOutput is documented thread-safe for capture operations.
extension AVCapturePhotoOutput: @unchecked Sendable {}

actor CameraController {
    // MARK: - User-configurable state

    /// Whether the camera is allowed to capture for talk (describe_view tool calls).
    var isEnabled: Bool = false
    /// Which camera to use for talk snaps.
    var preferredFacing: OpenClawCameraFacing = .front

    /// Enables or disables the camera and starts/stops the shared session atomically.
    /// Returns the running session when enabled, nil when disabled.
    func applyEnabled(_ enabled: Bool) async -> AVCaptureSession? {
        self.isEnabled = enabled
        if enabled {
            return try? await self.startSharedSession()
        } else {
            self.stopSharedSession()
            return nil
        }
    }

    /// Updates the preferred facing. Restarts the shared session only when enabled.
    /// Returns the running session if enabled, nil if disabled (facing is still persisted).
    func applyFacing(_ facing: OpenClawCameraFacing) async -> AVCaptureSession? {
        self.preferredFacing = facing
        guard self.isEnabled else { return nil }
        let session = try? await self.startSharedSession()
        // Re-check after suspension: applyEnabled(false) may have run while
        // startSharedSession was awaiting hardware access.
        guard self.isEnabled else {
            self.stopSharedSession()
            return nil
        }
        return session
    }

    struct CameraDeviceInfo: Codable {
        var id: String
        var name: String
        var position: String
        var deviceType: String
    }

    enum CameraError: LocalizedError {
        case cameraUnavailable
        case microphoneUnavailable
        case permissionDenied(kind: String)
        case invalidParams(String)
        case captureFailed(String)
        case exportFailed(String)

        var errorDescription: String? {
            switch self {
            case .cameraUnavailable:
                "Camera unavailable"
            case .microphoneUnavailable:
                "Microphone unavailable"
            case let .permissionDenied(kind):
                "\(kind) permission denied"
            case let .invalidParams(msg):
                msg
            case let .captureFailed(msg):
                msg
            case let .exportFailed(msg):
                msg
            }
        }
    }

    // MARK: - Shared persistent session (preview + snapForTalk)

    /// Running while camera is enabled; shared between preview layer and snapForTalk.
    /// Eliminates the per-snap session startup cost (~500 ms) and prevents the
    /// hardware interruption that freezes the preview when a second session starts.
    private var sharedSession: AVCaptureSession?
    private var sharedPhotoOutput: AVCapturePhotoOutput?

    // MARK: - Active streaming

    private var streamingTask: Task<Void, Never>?

    /// Starts periodic JPEG frame capture at the given fps, calling onFrame for each captured frame.
    /// Replaces any existing stream. Frames stop when stopStreaming() is called or the actor is released.
    /// onFrame is called sequentially — the next snap begins only after onFrame returns.
    func startStreaming(fps: Double = 1.0, onFrame: @Sendable @escaping (String) async -> Void) {
        self.streamingTask?.cancel()
        let intervalNs = UInt64(1_000_000_000.0 / max(0.1, min(fps, 5.0)))
        self.streamingTask = Task {
            while !Task.isCancelled {
                if let base64 = await self.snapForTalk(maxWidth: 480), !base64.isEmpty,
                   !Task.isCancelled
                {
                    await onFrame(base64)
                }
                try? await Task.sleep(nanoseconds: intervalNs)
            }
        }
    }

    func stopStreaming() {
        self.streamingTask?.cancel()
        self.streamingTask = nil
    }

    /// Start (or switch) the shared session for the current preferred facing.
    /// Returns the running session so CameraPreviewView can attach its preview layer.
    @discardableResult
    func startSharedSession() async throws -> AVCaptureSession {
        try await self.ensureAccess(for: .video)
        let position: AVCaptureDevice.Position = self.preferredFacing == .front ? .front : .back

        // Reuse if the current session is already running on the right camera.
        if let s = sharedSession, s.isRunning,
           (s.inputs.compactMap { $0 as? AVCaptureDeviceInput }.first?.device.position) == position
        { return s }

        self.sharedSession?.stopRunning()
        self.sharedSession = nil
        self.sharedPhotoOutput = nil

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
            ?? AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device)
        else { throw CameraError.cameraUnavailable }

        let s = AVCaptureSession()
        s.sessionPreset = .photo
        s.beginConfiguration()
        guard s.canAddInput(input) else {
            s.commitConfiguration()
            throw CameraError.cameraUnavailable
        }
        s.addInput(input)
        let photoOutput = AVCapturePhotoOutput()
        if s.canAddOutput(photoOutput) {
            s.addOutput(photoOutput)
            self.sharedPhotoOutput = photoOutput
        }
        s.commitConfiguration()

        self.sharedSession = s
        s.startRunning()
        return s
    }

    func stopSharedSession() {
        self.sharedSession?.stopRunning()
        self.sharedSession = nil
        self.sharedPhotoOutput = nil
    }

    // MARK: - Quick snap for talk (no URL prefix, 480p)

    /// Captures a single JPEG frame suitable for voice tool calls.
    /// Returns raw base64 (no data:URL prefix). Returns nil when disabled or permission denied.
    func snapForTalk(maxWidth: Int = 480) async -> String? {
        guard self.isEnabled else { return nil }
        do { try await self.ensureAccess(for: .video) } catch { return nil }

        // Fast path: shared session already running, no startup cost.
        if let output = sharedPhotoOutput, let s = sharedSession, s.isRunning {
            return await self.captureJPEGFromOutput(output, maxWidth: maxWidth, quality: 0.75)
        }

        // Slow fallback: shared session not ready yet (race during startup).
        let params = OpenClawCameraSnapParams(
            facing: preferredFacing,
            maxWidth: maxWidth,
            quality: 0.75,
            format: .jpg,
            deviceId: nil,
            delayMs: 0)
        return await (try? self.snap(params: params))?.base64
    }

    private func captureJPEGFromOutput(
        _ output: AVCapturePhotoOutput,
        maxWidth: Int,
        quality: Double) async -> String?
    {
        do {
            let rawData = try await CameraCapturePipelineSupport.capturePhotoData(output: output) {
                PhotoCaptureDelegate($0)
            }
            let res = try PhotoCapture.transcodeJPEGForGateway(
                rawData: rawData, maxWidthPx: maxWidth, quality: quality)
            return res.data.base64EncodedString()
        } catch {
            return nil
        }
    }

    func snap(params: OpenClawCameraSnapParams) async throws -> (
        format: String,
        base64: String,
        width: Int,
        height: Int)
    {
        let facing = params.facing ?? .front
        let format = params.format ?? .jpg
        // Default to a reasonable max width to keep gateway payload sizes manageable.
        // If you need the full-res photo, explicitly request a larger maxWidth.
        let maxWidth = params.maxWidth.flatMap { $0 > 0 ? $0 : nil } ?? 1600
        let quality = Self.clampQuality(params.quality)
        let delayMs = max(0, params.delayMs ?? 0)

        try await self.ensureAccess(for: .video)

        let prepared = try CameraCapturePipelineSupport.preparePhotoSession(
            preferFrontCamera: facing == .front,
            deviceId: params.deviceId,
            pickCamera: { preferFrontCamera, deviceId in
                Self.pickCamera(facing: preferFrontCamera ? .front : .back, deviceId: deviceId)
            },
            cameraUnavailableError: CameraError.cameraUnavailable,
            mapSetupError: { setupError in
                CameraError.captureFailed(setupError.localizedDescription)
            })
        let session = prepared.session
        let output = prepared.output

        session.startRunning()
        defer { session.stopRunning() }
        await CameraCapturePipelineSupport.warmUpCaptureSession()
        await Self.sleepDelayMs(delayMs)

        let rawData = try await CameraCapturePipelineSupport.capturePhotoData(output: output) { continuation in
            PhotoCaptureDelegate(continuation)
        }

        let res = try PhotoCapture.transcodeJPEGForGateway(
            rawData: rawData,
            maxWidthPx: maxWidth,
            quality: quality)

        return (
            format: format.rawValue,
            base64: res.data.base64EncodedString(),
            width: res.widthPx,
            height: res.heightPx)
    }

    func clip(params: OpenClawCameraClipParams) async throws -> (
        format: String,
        base64: String,
        durationMs: Int,
        hasAudio: Bool)
    {
        let facing = params.facing ?? .front
        let durationMs = Self.clampDurationMs(params.durationMs)
        let includeAudio = params.includeAudio ?? true
        let format = params.format ?? .mp4

        try await self.ensureAccess(for: .video)
        if includeAudio {
            try await self.ensureAccess(for: .audio)
        }

        let movURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-camera-\(UUID().uuidString).mov")
        let mp4URL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-camera-\(UUID().uuidString).mp4")
        defer {
            try? FileManager().removeItem(at: movURL)
            try? FileManager().removeItem(at: mp4URL)
        }

        let data = try await CameraCapturePipelineSupport.withWarmMovieSession(
            preferFrontCamera: facing == .front,
            deviceId: params.deviceId,
            includeAudio: includeAudio,
            durationMs: durationMs,
            pickCamera: { preferFrontCamera, deviceId in
                Self.pickCamera(facing: preferFrontCamera ? .front : .back, deviceId: deviceId)
            },
            cameraUnavailableError: CameraError.cameraUnavailable,
            mapSetupError: Self.mapMovieSetupError,
            operation: { output in
                var delegate: MovieFileDelegate?
                let recordedURL: URL = try await withCheckedThrowingContinuation { cont in
                    let d = MovieFileDelegate(cont)
                    delegate = d
                    output.startRecording(to: movURL, recordingDelegate: d)
                }
                withExtendedLifetime(delegate) {}
                // Transcode .mov -> .mp4 for easier downstream handling.
                try await Self.exportToMP4(inputURL: recordedURL, outputURL: mp4URL)
                return try Data(contentsOf: mp4URL)
            })
        return (
            format: format.rawValue,
            base64: data.base64EncodedString(),
            durationMs: durationMs,
            hasAudio: includeAudio)
    }

    func listDevices() -> [CameraDeviceInfo] {
        Self.discoverVideoDevices().map { device in
            CameraDeviceInfo(
                id: device.uniqueID,
                name: device.localizedName,
                position: Self.positionLabel(device.position),
                deviceType: device.deviceType.rawValue)
        }
    }

    private func ensureAccess(for mediaType: AVMediaType) async throws {
        if await !(CameraAuthorization.isAuthorized(for: mediaType)) {
            throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
        }
    }

    private nonisolated static func pickCamera(
        facing: OpenClawCameraFacing,
        deviceId: String?) -> AVCaptureDevice?
    {
        if let deviceId, !deviceId.isEmpty {
            if let match = discoverVideoDevices().first(where: { $0.uniqueID == deviceId }) {
                return match
            }
        }
        let position: AVCaptureDevice.Position = (facing == .front) ? .front : .back
        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) {
            return device
        }
        // Fall back to any default camera (e.g. simulator / unusual device configurations).
        return AVCaptureDevice.default(for: .video)
    }

    private nonisolated static func mapMovieSetupError(_ setupError: CameraSessionConfigurationError) -> CameraError {
        CameraCapturePipelineSupport.mapMovieSetupError(
            setupError,
            microphoneUnavailableError: .microphoneUnavailable,
            captureFailed: { .captureFailed($0) })
    }

    private nonisolated static func positionLabel(_ position: AVCaptureDevice.Position) -> String {
        CameraCapturePipelineSupport.positionLabel(position)
    }

    private nonisolated static func discoverVideoDevices() -> [AVCaptureDevice] {
        let types: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .builtInUltraWideCamera,
            .builtInTelephotoCamera,
            .builtInDualCamera,
            .builtInDualWideCamera,
            .builtInTripleCamera,
            .builtInTrueDepthCamera,
            .builtInLiDARDepthCamera,
        ]
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: .unspecified)
        return session.devices
    }

    nonisolated static func clampQuality(_ quality: Double?) -> Double {
        let q = quality ?? 0.9
        return min(1.0, max(0.05, q))
    }

    nonisolated static func clampDurationMs(_ ms: Int?) -> Int {
        let v = ms ?? 3000
        // Keep clips short by default; avoid huge base64 payloads on the gateway.
        return min(60000, max(250, v))
    }

    private nonisolated static func exportToMP4(inputURL: URL, outputURL: URL) async throws {
        let asset = AVURLAsset(url: inputURL)
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            throw CameraError.exportFailed("Failed to create export session")
        }
        exporter.shouldOptimizeForNetworkUse = true

        if #available(iOS 18.0, tvOS 18.0, visionOS 2.0, *) {
            do {
                try await exporter.export(to: outputURL, as: .mp4)
                return
            } catch {
                throw CameraError.exportFailed(error.localizedDescription)
            }
        } else {
            exporter.outputURL = outputURL
            exporter.outputFileType = .mp4

            try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
                exporter.exportAsynchronously {
                    cont.resume(returning: ())
                }
            }

            switch exporter.status {
            case .completed:
                return
            case .failed:
                throw CameraError.exportFailed(exporter.error?.localizedDescription ?? "export failed")
            case .cancelled:
                throw CameraError.exportFailed("export cancelled")
            default:
                throw CameraError.exportFailed("export did not complete")
            }
        }
    }

    private nonisolated static func sleepDelayMs(_ delayMs: Int) async {
        guard delayMs > 0 else { return }
        let maxDelayMs = 10 * 1000
        let ns = UInt64(min(delayMs, maxDelayMs)) * UInt64(NSEC_PER_MSEC)
        try? await Task.sleep(nanoseconds: ns)
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let continuation: CheckedContinuation<Data, Error>
    private let resumed = OSAllocatedUnfairLock(initialState: false)

    init(_ continuation: CheckedContinuation<Data, Error>) {
        self.continuation = continuation
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?)
    {
        let alreadyResumed = self.resumed.withLock { old in
            let was = old
            old = true
            return was
        }
        guard !alreadyResumed else { return }

        if let error {
            self.continuation.resume(throwing: error)
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            self.continuation.resume(
                throwing: NSError(domain: "Camera", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "photo data missing",
                ]))
            return
        }
        if data.isEmpty {
            self.continuation.resume(
                throwing: NSError(domain: "Camera", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "photo data empty",
                ]))
            return
        }
        self.continuation.resume(returning: data)
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings,
        error: Error?)
    {
        guard let error else { return }
        let alreadyResumed = self.resumed.withLock { old in
            let was = old
            old = true
            return was
        }
        guard !alreadyResumed else { return }
        self.continuation.resume(throwing: error)
    }
}

private final class MovieFileDelegate: NSObject, AVCaptureFileOutputRecordingDelegate {
    private let continuation: CheckedContinuation<URL, Error>
    private let resumed = OSAllocatedUnfairLock(initialState: false)

    init(_ continuation: CheckedContinuation<URL, Error>) {
        self.continuation = continuation
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?)
    {
        let alreadyResumed = self.resumed.withLock { old in
            let was = old
            old = true
            return was
        }
        guard !alreadyResumed else { return }

        if let error {
            let ns = error as NSError
            if ns.domain == AVFoundationErrorDomain,
               ns.code == AVError.maximumDurationReached.rawValue
            {
                self.continuation.resume(returning: outputFileURL)
                return
            }
            self.continuation.resume(throwing: error)
            return
        }
        self.continuation.resume(returning: outputFileURL)
    }
}
