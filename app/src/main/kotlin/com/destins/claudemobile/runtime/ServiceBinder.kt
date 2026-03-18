package com.destins.claudemobile.runtime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first

class ServiceBinder(private val context: Context) {
    private var service: SessionService? = null
    private val _state = MutableStateFlow<SessionState>(SessionState.Disconnected)
    val state: StateFlow<SessionState> = _state
    private val serviceBound = MutableStateFlow<SessionService?>(null)

    sealed class SessionState {
        data object Disconnected : SessionState()
        data object Connecting : SessionState()
        data class Connected(val bridge: PtyBridge) : SessionState()
        data class Error(val message: String) : SessionState()
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as SessionService.LocalBinder).service
            service = svc
            serviceBound.value = svc
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            serviceBound.value = null
            _state.value = SessionState.Disconnected
        }
    }

    fun bind() {
        val intent = Intent(context, SessionService::class.java)
        context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    suspend fun startSession(bootstrap: Bootstrap, apiKey: String? = null) {
        _state.value = SessionState.Connecting
        val intent = Intent(context, SessionService::class.java)
        context.startForegroundService(intent)

        try {
            val svc = serviceBound.filterNotNull().first()
            svc.startSession(bootstrap, apiKey)
            svc.ptyBridge?.let {
                _state.value = SessionState.Connected(it)
            } ?: run {
                _state.value = SessionState.Error("PTY bridge failed to start")
            }
        } catch (e: Exception) {
            _state.value = SessionState.Error(e.message ?: "Failed to start session")
        }
    }

    fun stopSession() {
        service?.stopSession()
        _state.value = SessionState.Disconnected
    }

    fun unbind() {
        try {
            context.unbindService(connection)
        } catch (_: Exception) {}
    }
}
