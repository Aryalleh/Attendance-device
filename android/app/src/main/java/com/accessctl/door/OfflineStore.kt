package com.accessctl.door

import android.content.Context
import java.io.File

/**
 * Card cache for the offline fallback and the queue of scans decided while the server
 * was unreachable — the phone equivalent of the firmware's cache.tsv / queue.tsv.
 */
class OfflineStore(context: Context) {

    class Card(val uid: String, val enabled: Boolean, var inside: Boolean, val name: String)
    class Queued(val ts: Long, val uid: String, val result: String, val direction: String)

    private val cardsFile = File(context.filesDir, "cards.tsv")
    private val queueFile = File(context.filesDir, "queue.tsv")
    private val cards = HashMap<String, Card>()

    init { loadCards() }

    // ---- card cache ----

    @Synchronized
    fun replaceCards(tsv: String) {
        cards.clear()
        parseInto(tsv)
        saveCards()
    }

    @Synchronized
    fun find(uid: String): Card? = cards[uid]

    @Synchronized
    fun setInside(uid: String, inside: Boolean) {
        val c = cards[uid] ?: return
        if (c.inside != inside) { c.inside = inside; saveCards() }
    }

    @Synchronized
    fun cardCount() = cards.size

    private fun loadCards() {
        if (cardsFile.exists()) parseInto(cardsFile.readText())
    }

    private fun parseInto(tsv: String) {
        for (line in tsv.lineSequence()) {
            val p = line.split('\t')
            if (p.size >= 4 && p[0].isNotBlank()) cards[p[0]] = Card(p[0], p[1] == "1", p[2] == "1", p[3])
        }
    }

    private fun saveCards() {
        val sb = StringBuilder()
        for (c in cards.values) {
            sb.append(c.uid).append('\t').append(if (c.enabled) 1 else 0).append('\t')
                .append(if (c.inside) 1 else 0).append('\t').append(c.name.replace('\t', ' ')).append('\n')
        }
        writeAtomic(cardsFile, sb.toString())
    }

    // ---- offline queue ----

    @Synchronized
    fun enqueue(q: Queued) {
        queueFile.appendText("${q.ts}\t${q.uid}\t${q.result}\t${q.direction}\n")
    }

    @Synchronized
    fun queued(): List<Queued> {
        if (!queueFile.exists()) return emptyList()
        return queueFile.readLines().mapNotNull { line ->
            val p = line.split('\t')
            if (p.size < 4) null else Queued(p[0].toLongOrNull() ?: 0, p[1], p[2], p[3])
        }
    }

    /** Drop the first [n] entries (the ones the server just accepted); newer scans stay. */
    @Synchronized
    fun dropQueued(n: Int) {
        if (n <= 0 || !queueFile.exists()) return
        val rest = queued().drop(n)
        if (rest.isEmpty()) queueFile.delete()
        else writeAtomic(queueFile, rest.joinToString("") { "${it.ts}\t${it.uid}\t${it.result}\t${it.direction}\n" })
    }

    private fun writeAtomic(f: File, text: String) {
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }
}
