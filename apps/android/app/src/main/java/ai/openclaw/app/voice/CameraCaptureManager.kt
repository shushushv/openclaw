package ai.openclaw.app.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Captures JPEG frames from the camera for realtime video sharing in a relay talk session.
 *
 * Maintains a persistent CameraX binding that includes both [ImageCapture] and optionally a
 * [Preview] use case when a [PreviewView] is attached via [attachPreviewView].  CameraX requires
 * all use cases for the same camera to be bound in a single [bindToLifecycle] call, so binding is
 * lazily established and invalidated only when the facing or preview surface changes.
 *
 * Frame data is raw base64 (no data-URL prefix) with JPEG quality 80 at up to 640×480.
 */
class VoiceCameraCaptureManager(private val context: Context) {
  companion object {
    private const val tag = "VoiceCameraCapture"
    private const val captureTimeoutMs = 5_000L
    private const val maxWidthPx = 640
    private const val maxHeightPx = 480
    private const val jpegQuality = 80
  }

  @Volatile private var lifecycleOwner: LifecycleOwner? = null
  @Volatile private var streamingJob: Job? = null

  // Persistent binding state; all mutations happen on the Main thread.
  private var previewView: PreviewView? = null
  private var cameraSelector: CameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
  private var boundProvider: ProcessCameraProvider? = null
  private var boundCapture: ImageCapture? = null

  /** Must be called before [startStreaming] or [captureFrame]. Attaches the activity lifecycle. */
  fun attachLifecycleOwner(owner: LifecycleOwner) {
    lifecycleOwner = owner
  }

  /**
   * Attaches a [PreviewView] so the camera feed is rendered in the UI.  Pass null to detach.
   * Changing the preview view invalidates the current binding so the next capture rebinds with
   * the correct set of use cases.  Must be called from the Main thread.
   */
  fun attachPreviewView(view: PreviewView?) {
    previewView = view
    invalidateBound()
  }

  /**
   * Switches the active camera to [selector].  Invalidates the current binding so the next
   * capture rebinds on the chosen camera.  Must be called from the Main thread.
   */
  fun setFacing(selector: CameraSelector) {
    if (cameraSelector == selector) return
    cameraSelector = selector
    invalidateBound()
  }

  /**
   * Starts streaming at [fps] frames per second.  Each frame is delivered to [onFrame]
   * as raw JPEG base64.  Frames are dropped silently when the previous capture is still
   * in-flight (drop strategy).  Does nothing when CAMERA permission is not granted.
   */
  fun startStreaming(
    scope: CoroutineScope,
    fps: Double,
    onFrame: (String) -> Unit,
  ) {
    if (!hasCameraPermission()) {
      Log.w(tag, "startStreaming: camera permission not granted")
      return
    }
    val intervalMs = if (fps > 0) (1000.0 / fps).toLong().coerceAtLeast(100L) else 1000L
    val inFlight = AtomicBoolean(false)

    streamingJob?.cancel()
    streamingJob =
      scope.launch(Dispatchers.Main) {
        while (isActive) {
          val frameStart = System.currentTimeMillis()
          if (inFlight.compareAndSet(false, true)) {
            launch {
              try {
                val base64 = takeSingleFrame() ?: return@launch
                onFrame(base64)
              } catch (err: CancellationException) {
                throw err
              } catch (err: Throwable) {
                Log.w(tag, "streaming frame failed: ${err.message ?: err::class.simpleName}")
              } finally {
                inFlight.set(false)
              }
            }
          }
          val elapsed = System.currentTimeMillis() - frameStart
          val remaining = intervalMs - elapsed
          if (remaining > 0) delay(remaining)
        }
      }
    Log.d(tag, "streaming started fps=$fps")
  }

  /** Stops the streaming loop started by [startStreaming]. */
  fun stopStreaming() {
    streamingJob?.cancel()
    streamingJob = null
    Log.d(tag, "streaming stopped")
  }

  /**
   * Proactively establishes the camera binding so the [PreviewView] shows the feed immediately,
   * without waiting for the first [captureFrame] call.  Safe to call even when already bound.
   */
  fun startPreview(scope: CoroutineScope) {
    if (!hasCameraPermission()) return
    scope.launch(Dispatchers.Main) {
      try { ensureBound() } catch (err: Throwable) {
        Log.w(tag, "startPreview: bind failed: ${err.message}")
      }
    }
  }

  /**
   * Releases the camera binding and stops streaming.  Call when the preview is dismissed or the
   * talk session ends to free the camera for other apps.
   */
  fun releaseCamera() {
    streamingJob?.cancel()
    streamingJob = null
    invalidateBound()
    Log.d(tag, "camera released")
  }

  /**
   * Captures a single frame and returns raw JPEG base64 (no prefix).
   * Returns null when CAMERA permission is missing or capture times out.
   */
  suspend fun captureFrame(): String? {
    if (!hasCameraPermission()) {
      Log.w(tag, "captureFrame: camera permission not granted")
      return null
    }
    return withTimeoutOrNull(captureTimeoutMs) { takeSingleFrame() }
  }

  // ---------- internals ----------

  private fun invalidateBound() {
    boundProvider?.unbindAll()
    boundProvider = null
    boundCapture = null
  }

  /**
   * Ensures Preview + ImageCapture are bound to the current lifecycle and returns the
   * [ImageCapture] instance for frame capture.  Re-binds lazily when facing or preview changes.
   * Must be called from the Main dispatcher.
   */
  private suspend fun ensureBound(): ImageCapture {
    val existing = boundCapture
    if (existing != null) return existing

    val owner = lifecycleOwner ?: error("no lifecycle owner attached")
    val provider = context.awaitCameraProvider()
    val capture = ImageCapture.Builder().build()

    val useCases = buildList {
      add(capture)
      previewView?.let { view ->
        val preview = Preview.Builder().build()
        preview.setSurfaceProvider(view.surfaceProvider)
        add(preview)
      }
    }

    provider.bindToLifecycle(owner, cameraSelector, *useCases.toTypedArray())

    boundProvider = provider
    boundCapture = capture
    return capture
  }

  private suspend fun takeSingleFrame(): String? =
    withContext(Dispatchers.Main) {
      try {
        val capture = ensureBound()
        val jpeg = capture.takeJpegBytes(context.cacheDir)
        encodeJpeg(jpeg)
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        Log.w(tag, "takeSingleFrame failed: ${err.message ?: err::class.simpleName}")
        null
      }
    }

  private fun encodeJpeg(jpeg: ByteArray): String? {
    return try {
      // Check dimensions before full decode; return original bytes when already within bounds.
      val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, opts)
      if (opts.outWidth in 1..maxWidthPx && opts.outHeight in 1..maxHeightPx) {
        return Base64.encodeToString(jpeg, Base64.NO_WRAP)
      }
      val bitmap =
        BitmapFactory.decodeByteArray(
          jpeg, 0, jpeg.size,
          BitmapFactory.Options().apply {
            inSampleSize = computeInSampleSize(opts.outWidth, opts.outHeight)
          },
        ) ?: return null
      val scaled = scaleBitmap(bitmap)
      val out = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
      if (scaled !== bitmap) scaled.recycle()
      bitmap.recycle()
      Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    } catch (err: Throwable) {
      Log.w(tag, "encodeJpeg failed: ${err.message ?: err::class.simpleName}")
      null
    }
  }

  private fun computeInSampleSize(srcWidth: Int, srcHeight: Int): Int {
    var size = 1
    // Use || so we keep halving while *either* dimension still exceeds its max.
    // With &&, common resolutions like 1280×720 (720/2=360 < 480) would exit
    // immediately and leave size=1, defeating the optimization.
    while (srcWidth / (size * 2) >= maxWidthPx || srcHeight / (size * 2) >= maxHeightPx) {
      size *= 2
    }
    return size
  }

  private fun scaleBitmap(bitmap: Bitmap): Bitmap {
    if (bitmap.width <= maxWidthPx && bitmap.height <= maxHeightPx) return bitmap
    val wRatio = maxWidthPx.toFloat() / bitmap.width
    val hRatio = maxHeightPx.toFloat() / bitmap.height
    val ratio = minOf(wRatio, hRatio)
    val newW = (bitmap.width * ratio).toInt().coerceAtLeast(1)
    val newH = (bitmap.height * ratio).toInt().coerceAtLeast(1)
    return Bitmap.createScaledBitmap(bitmap, newW, newH, true)
  }

  private fun hasCameraPermission(): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED
}

private suspend fun Context.awaitCameraProvider(): ProcessCameraProvider =
  suspendCancellableCoroutine { cont ->
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener(
      {
        try {
          cont.resume(future.get())
        } catch (err: Exception) {
          cont.resumeWithException(err)
        }
      },
      ContextCompat.getMainExecutor(this),
    )
  }

private suspend fun ImageCapture.takeJpegBytes(tempDir: File): ByteArray =
  suspendCancellableCoroutine { cont ->
    val file = File.createTempFile("openclaw-voice-snap-", ".jpg", tempDir)
    val options = ImageCapture.OutputFileOptions.Builder(file).build()
    val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
    cont.invokeOnCancellation {
      file.delete()
      executor.shutdownNow()
    }
    takePicture(
      options,
      executor,
      object : ImageCapture.OnImageSavedCallback {
        override fun onError(exception: ImageCaptureException) {
          file.delete()
          executor.shutdown()
          cont.resumeWithException(exception)
        }

        override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
          try {
            val bytes = file.readBytes()
            cont.resume(bytes)
          } catch (err: Exception) {
            cont.resumeWithException(err)
          } finally {
            file.delete()
            executor.shutdown()
          }
        }
      },
    )
  }
