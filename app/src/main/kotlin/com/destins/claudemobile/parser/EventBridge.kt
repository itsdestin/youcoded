package com.destins.claudemobile.parser

import android.net.LocalSocket
import android.net.LocalSocketAddress
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream

class EventBridge(private val socketPath: String) {
    private val _events = MutableSharedFlow<ParsedEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<ParsedEvent> = _events

    var onConnected: (() -> Unit)? = null

    private var socket: LocalSocket? = null
    private var outputStream: OutputStream? = null
    private var readJob: Job? = null

    fun connect(scope: CoroutineScope) {
        readJob = scope.launch(Dispatchers.IO) {
            retry@ while (isActive) {
                try {
                    val s = LocalSocket()
                    s.connect(LocalSocketAddress(socketPath, LocalSocketAddress.Namespace.FILESYSTEM))
                    socket = s
                    outputStream = s.outputStream
                    onConnected?.invoke()

                    val reader = BufferedReader(InputStreamReader(s.inputStream))
                    while (isActive) {
                        val line = reader.readLine() ?: break
                        ParsedEvent.fromJson(line)?.let { _events.emit(it) }
                    }
                } catch (e: Exception) {
                    delay(1000)
                }
            }
        }
    }

    fun sendPtyOutput(data: String) {
        try {
            outputStream?.write(data.toByteArray())
            outputStream?.flush()
        } catch (_: Exception) {}
    }

    fun disconnect() {
        readJob?.cancel()
        socket?.close()
        socket = null
        outputStream = null
    }
}
