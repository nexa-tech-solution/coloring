package com.nexa.coloring

import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.util.Base64
import android.provider.MediaStore
import android.widget.Toast
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class ImageShareModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  override fun getName() = "ImageShare"

  private fun writeImageToPhotos(dataUrl: String, filename: String) =
    context.contentResolver.run {
      val imageData = dataUrl.substringAfter(',', dataUrl)
      val bytes = Base64.decode(imageData, Base64.DEFAULT)
      val safeName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_")
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, safeName)
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Coloring")
          put(MediaStore.Images.Media.IS_PENDING, 1)
        }
      }
      val uri = insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("Could not create the image in Photos")

      try {
        openOutputStream(uri)?.use { it.write(bytes) }
          ?: throw IllegalStateException("Could not write the image")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          update(
            uri,
            ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
            null,
            null,
          )
        }
        uri
      } catch (error: Exception) {
        delete(uri, null, null)
        throw error
      }
    }

  @ReactMethod
  fun saveImage(dataUrl: String, filename: String, promise: Promise) {
    try {
      writeImageToPhotos(dataUrl, filename)
      Toast.makeText(context, "Saved to Photos", Toast.LENGTH_SHORT).show()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("IMAGE_SAVE_FAILED", "Could not save the image to Photos", error)
    }
  }

  @ReactMethod
  fun shareImage(dataUrl: String, filename: String, promise: Promise) {
    try {
      val imageData = dataUrl.substringAfter(',', dataUrl)
      val bytes = Base64.decode(imageData, Base64.DEFAULT)
      val safeName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_")
      val shareDirectory = File(context.cacheDir, "shared-images").apply { mkdirs() }
      val imageFile = File(shareDirectory, safeName).apply { writeBytes(bytes) }
      val uri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.imageshare",
        imageFile,
      )
      val shareIntent = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(shareIntent, "Share coloring").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(chooser)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("IMAGE_SHARE_FAILED", "Could not open the share sheet", error)
    }
  }
}
