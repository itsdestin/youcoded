package com.destin.code.config

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class WorkingDir(val label: String, val path: String)

class WorkingDirStore(private val homeDir: File) {
    private val file = File(homeDir, ".claude-mobile/working-dirs.json")
    private val _dirs = MutableStateFlow<List<WorkingDir>>(emptyList())
    val dirs: StateFlow<List<WorkingDir>> = _dirs

    init { reload() }

    fun reload() {
        _dirs.value = readFromDisk()
    }

    fun add(dir: WorkingDir) {
        val current = _dirs.value.toMutableList()
        if (current.any { it.path == dir.path }) return // duplicate
        current.add(dir)
        _dirs.value = current
        writeToDisk(current)
    }

    fun remove(path: String) {
        val current = _dirs.value.toMutableList()
        current.removeAll { it.path == path }
        _dirs.value = current
        writeToDisk(current)
    }

    /** All dirs including implicit Home (~) as first entry. */
    fun allDirs(): List<Pair<String, File>> {
        val list = mutableListOf("Home (~)" to homeDir)
        for (wd in _dirs.value) {
            list.add(wd.label to File(wd.path))
        }
        return list
    }

    private fun readFromDisk(): List<WorkingDir> {
        if (!file.exists()) return emptyList()
        return try {
            val arr = JSONArray(file.readText())
            (0 until arr.length()).mapNotNull { i ->
                val obj = arr.optJSONObject(i) ?: return@mapNotNull null
                val label = obj.optString("label", "")
                val path = obj.optString("path", "")
                if (label.isNotBlank() && path.isNotBlank()) WorkingDir(label, path) else null
            }
        } catch (_: Exception) {
            android.util.Log.w("WorkingDirStore", "Invalid JSON in ${file.absolutePath}, treating as empty")
            emptyList()
        }
    }

    private fun writeToDisk(dirs: List<WorkingDir>) {
        file.parentFile?.mkdirs()
        val arr = JSONArray()
        for (wd in dirs) {
            val obj = JSONObject()
            obj.put("label", wd.label)
            obj.put("path", wd.path)
            arr.put(obj)
        }
        file.writeText(arr.toString(2))
    }
}
