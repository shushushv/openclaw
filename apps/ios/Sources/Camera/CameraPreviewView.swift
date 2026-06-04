import AVFoundation
import OpenClawKit
import SwiftUI

/// AVCaptureSession is documented thread-safe for session control operations.
/// This conformance lets it cross actor isolation boundaries safely.
extension AVCaptureSession: @unchecked Sendable {}

/// Live camera preview backed by AVCaptureVideoPreviewLayer.
/// Attaches a preview layer to a caller-managed session; does NOT start or stop the session.
struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> CameraHostView {
        let view = CameraHostView()
        view.backgroundColor = .black
        view.coordinator = context.coordinator
        context.coordinator.attach(to: view, session: self.session)
        return view
    }

    func updateUIView(_ view: CameraHostView, context: Context) {
        context.coordinator.update(session: self.session, in: view)
    }

    static func dismantleUIView(_ view: CameraHostView, coordinator: Coordinator) {
        // Only remove the preview layer; session lifecycle is owned by CameraController.
        coordinator.detach()
    }

    // MARK: -

    /// Attaches/detaches AVCaptureVideoPreviewLayer. Does not own the session.
    final class Coordinator {
        private(set) var previewLayer: AVCaptureVideoPreviewLayer?
        private weak var attachedSession: AVCaptureSession?

        func attach(to view: UIView, session: AVCaptureSession) {
            self.attachLayer(for: session, in: view)
        }

        func update(session: AVCaptureSession, in view: UIView) {
            guard session !== self.attachedSession else { return }
            self.attachLayer(for: session, in: view)
        }

        func detach() {
            self.previewLayer?.removeFromSuperlayer()
            self.previewLayer = nil
            self.attachedSession = nil
        }

        func layoutPreviewLayer(in bounds: CGRect) {
            self.previewLayer?.frame = bounds
        }

        private func attachLayer(for session: AVCaptureSession, in view: UIView) {
            self.previewLayer?.removeFromSuperlayer()
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspect
            layer.frame = view.bounds
            view.layer.insertSublayer(layer, at: 0)
            self.previewLayer = layer
            self.attachedSession = session
        }
    }
}

// MARK: -

/// Host UIView that propagates layout changes to the coordinator.
final class CameraHostView: UIView {
    weak var coordinator: CameraPreviewView.Coordinator?

    override func layoutSubviews() {
        super.layoutSubviews()
        self.coordinator?.layoutPreviewLayer(in: self.bounds)
    }
}
