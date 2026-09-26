package dev.agentstack.app.share

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Publish complete UTF-8 bytes; a killed writer leaves the prior file intact. */
internal fun writeAtomically(file: File, text: String) {
    file.parentFile?.mkdirs()
    val temporary = File(file.parentFile, "${file.name}.writing")
    FileOutputStream(temporary).use { stream ->
        stream.write(text.toByteArray(Charsets.UTF_8))
        stream.fd.sync()
    }
    Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
}
