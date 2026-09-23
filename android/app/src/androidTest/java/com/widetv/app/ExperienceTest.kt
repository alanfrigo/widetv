package com.widetv.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.view.View
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.widetv.app.net.ApiClient
import com.widetv.app.net.Store
import com.widetv.app.ui.PosterLoader
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ExperienceTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var server: MockWebServer
    private var episodeCount = 30
    private val channels = JSONArray((1..500).map { n -> JSONObject()
        .put("number", n).put("name", "Série $n").put("episodeCount", 30)
        .put("seasons", JSONArray().put(1)) })

    @Before fun setup() {
        context.getSharedPreferences("widetv", Context.MODE_PRIVATE).edit().clear().commit()
        PosterLoader.clear()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = when {
                    request.path == "/api/channels" -> channels.toString()
                    request.path?.endsWith("/episodes") == true -> JSONArray((1..episodeCount).map { n -> JSONObject()
                        .put("id", "episode-$n").put("title", "Episódio $n").put("season", 1).put("episode", n)
                        .put("durationMs", 10000).put("audioTracks", JSONArray()).put("subtitleTracks", JSONArray()) }).toString()
                    request.path == "/api/auth/session" -> "{}"
                    request.path == "/api/settings" -> return MockResponse().setResponseCode(404)
                    else -> "[]"
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
        Store(context).serverUrl = server.url("/").toString()
    }

    @After fun cleanup() { PosterLoader.clear(); server.shutdown() }

    private fun awaitUi(scenario: ActivityScenario<MainActivity>, assertion: (MainActivity) -> Unit) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var failure: AssertionError? = null
        do {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            scenario.onActivity { activity ->
                try { assertion(activity); failure = null } catch (error: AssertionError) { failure = error }
            }
            if (failure == null) return
            Thread.sleep(50)
        } while (System.nanoTime() < deadline)
        throw failure!!
    }

    @Test fun catalogFocusSurvivesSeriesAndBackground() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitUi(scenario) { activity ->
                assertEquals(500, activity.findViewById<RecyclerView>(R.id.rail_shelf).adapter!!.itemCount)
            }
            scenario.onActivity { activity ->
                val card = activity.findViewById<RecyclerView>(R.id.rail_shelf).findViewHolderForAdapterPosition(0)!!.itemView
                card.requestFocus()
                card.performClick()
            }
            awaitUi(scenario) { activity ->
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.series).visibility)
                assertEquals(30, activity.findViewById<RecyclerView>(R.id.series_episodes).adapter!!.itemCount)
            }
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            awaitUi(scenario) { activity -> assertNotNull(activity.currentFocus) }
            scenario.onActivity { it.findViewById<View>(R.id.series_back).performClick() }
            awaitUi(scenario) { activity ->
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.home).visibility)
                assertNotNull(activity.currentFocus)
            }
        }
    }

    @Test fun longSeasonsRecycleRowsAndCanReachTheLastEpisode() {
        episodeCount = 500
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitUi(scenario) { activity -> assertEquals(500, activity.findViewById<RecyclerView>(R.id.rail_shelf).adapter!!.itemCount) }
            scenario.onActivity { activity -> activity.findViewById<RecyclerView>(R.id.rail_shelf).findViewHolderForAdapterPosition(0)!!.itemView.performClick() }
            awaitUi(scenario) { activity ->
                val list = activity.findViewById<RecyclerView>(R.id.series_episodes)
                assertEquals(500, list.adapter!!.itemCount)
                assertTrue("Only visible rows should be inflated", list.childCount < 20)
                list.scrollToPosition(499)
            }
            awaitUi(scenario) { activity ->
                val last = activity.findViewById<RecyclerView>(R.id.series_episodes).findViewHolderForAdapterPosition(499)
                assertNotNull(last)
                last!!.itemView.requestFocus()
                assertTrue(last.itemView.hasFocus())
            }
            awaitUi(scenario) { activity ->
                val row = activity.findViewById<RecyclerView>(R.id.series_episodes).findViewHolderForAdapterPosition(499)!!.itemView
                val visible = android.graphics.Rect()
                assertTrue(row.getGlobalVisibleRect(visible))
                assertTrue(row.height > 0)
                assertTrue("Focused episode must be fully visible", visible.height() >= row.height)
                assertTrue("Focused episode must be inside the display", visible.top >= 0 && visible.bottom <= activity.resources.displayMetrics.heightPixels)
            }
            if (InstrumentationRegistry.getArguments().getString("screenshots") == "true") {
                val instrumentation = InstrumentationRegistry.getInstrumentation()
                instrumentation.waitForIdleSync()
                val frames = java.util.concurrent.CountDownLatch(1)
                scenario.onActivity { activity ->
                    activity.window.decorView.postOnAnimation { activity.window.decorView.postOnAnimation { frames.countDown() } }
                }
                assertTrue(frames.await(3, TimeUnit.SECONDS))
                val bitmap = instrumentation.uiAutomation.takeScreenshot()
                java.io.File(context.getExternalFilesDir(null), "series-tv.png").outputStream().use {
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                }
                bitmap.recycle()
            }
        }
    }

    @Test fun performanceComparison() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("benchmark") == "true")
        episodeCount = 500
        val samples = JSONArray()
        repeat(5) {
            val start = android.os.SystemClock.elapsedRealtimeNanos()
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                awaitUi(scenario) { activity -> assertEquals(500, activity.findViewById<RecyclerView>(R.id.rail_shelf).adapter!!.itemCount) }
                val catalogMs = (android.os.SystemClock.elapsedRealtimeNanos() - start) / 1_000_000.0
                val cycles = JSONArray()
                repeat(10) {
                    val opened = android.os.SystemClock.elapsedRealtimeNanos()
                    scenario.onActivity { activity -> activity.findViewById<RecyclerView>(R.id.rail_shelf).findViewHolderForAdapterPosition(0)!!.itemView.performClick() }
                    var rows = 0
                    awaitUi(scenario) { activity ->
                        val list = activity.findViewById<RecyclerView>(R.id.series_episodes)
                        assertEquals(500, list.adapter!!.itemCount)
                        assertTrue(list.childCount > 0)
                        rows = list.childCount
                    }
                    val seriesMs = (android.os.SystemClock.elapsedRealtimeNanos() - opened) / 1_000_000.0
                    Runtime.getRuntime().gc()
                    cycles.put(JSONObject().put("seriesMs", seriesMs).put("rows", rows)
                        .put("heapBytes", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory())
                        .put("pssKb", android.os.Debug.getPss()))
                    scenario.onActivity { activity -> activity.findViewById<View>(R.id.series_back).performClick() }
                    awaitUi(scenario) { activity -> assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.home).visibility) }
                }
                val sample = JSONObject().put("catalogMs", catalogMs).put("cycles", cycles)
                samples.put(sample)
                android.util.Log.i("WideTVBenchmark", sample.toString())
            }
        }
        java.io.File(context.getExternalFilesDir(null), "performance.json").writeText(samples.toString(2))
    }

    @Test fun aNewTuneCancelsThePreviousInitialProbe() {
        val firstProbe = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val tuned = java.util.concurrent.CountDownLatch(1)
        val received = java.util.concurrent.CopyOnWriteArrayList<Int>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val channel = if (request.path == "/api/channels/1/now") 1 else 2
                if (request.path?.endsWith("/now") == true) {
                    fun episode(id: String) = JSONObject().put("id", id).put("title", id).put("durationMs", 10000)
                    return MockResponse().setBody(JSONObject()
                        .put("channel", JSONObject().put("number", channel).put("name", "Canal $channel").put("episodeCount", 2))
                        .put("episode", episode("ep$channel")).put("next", episode("next$channel"))
                        .put("offsetMs", 0).put("serverTimeMs", System.currentTimeMillis())
                        .put("endsAtMs", System.currentTimeMillis() + 10000).toString())
                }
                if (request.method == "HEAD" && request.path == "/api/stream/ep1") {
                    firstProbe.countDown()
                    release.await(5, TimeUnit.SECONDS)
                }
                return MockResponse().setResponseCode(404)
            }
        }
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)
        lateinit var player: com.widetv.app.player.ChannelPlayer
        lateinit var first: kotlinx.coroutines.Job
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            player = com.widetv.app.player.ChannelPlayer(context, ApiClient(Store(context)), scope,
                object : com.widetv.app.player.ChannelPlayer.Events {
                    override fun onTuned(playing: com.widetv.app.net.NowPlaying) { received.add(playing.channel.number); tuned.countDown() }
                    override fun onEpisodeChange(playing: com.widetv.app.net.NowPlaying) {}
                    override fun onStalled() {}
                    override fun onError(error: Throwable) {}
                    override fun onVodEpisode(channel: com.widetv.app.net.ChannelSummary, episode: com.widetv.app.net.EpisodeRef) {}
                    override fun onVodEnded() {}
                })
            first = scope.launch { player.tune(1) }
        }
        try {
            assertTrue(firstProbe.await(5, TimeUnit.SECONDS))
            instrumentation.runOnMainSync { scope.launch { player.tune(2) } }
            assertTrue(tuned.await(5, TimeUnit.SECONDS))
            assertTrue(first.isCancelled)
            assertEquals(listOf(2), received.toList())
        } finally {
            release.countDown()
            instrumentation.runOnMainSync { player.release(); scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel() }
        }
    }

    @Test fun imagesShareRequestsAndNeverCrossServers() = runBlocking {
        fun png(color: Int): Buffer {
            val bitmap = Bitmap.createBitmap(20, 20, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(color)
            val bytes = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
            bitmap.recycle()
            return Buffer().write(bytes.toByteArray())
        }
        val first = MockWebServer()
        val second = MockWebServer()
        first.enqueue(MockResponse().setBody(png(Color.RED)).setBodyDelay(150, TimeUnit.MILLISECONDS))
        second.enqueue(MockResponse().setBody(png(Color.BLUE)))
        first.start(); second.start()
        try {
            val store = Store(context)
            store.serverUrl = first.url("/").toString()
            val api = ApiClient(store)
            val images = (1..12).map { async { PosterLoader.load(api, "/poster?v=1", 20) } }.awaitAll()
            assertEquals(1, first.requestCount)
            assertTrue(images.all { it?.getPixel(0, 0) == Color.RED })
            store.serverUrl = second.url("/").toString()
            assertNull(PosterLoader.cached(api, "/poster?v=1", 20))
            assertEquals(Color.BLUE, PosterLoader.load(api, "/poster?v=1", 20)!!.getPixel(0, 0))
            PosterLoader.clear()
            assertNull(PosterLoader.cached(api, "/poster?v=1", 20))
        } finally { first.shutdown(); second.shutdown() }
    }

    @Test fun imageConcurrencyIsBoundedAndCancellingOneReaderKeepsTheOther() = runBlocking {
        val active = java.util.concurrent.atomic.AtomicInteger()
        val peak = java.util.concurrent.atomic.AtomicInteger()
        val images = MockWebServer()
        images.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val count = active.incrementAndGet()
                peak.updateAndGet { previous -> maxOf(previous, count) }
                Thread.sleep(100)
                active.decrementAndGet()
                return MockResponse().setResponseCode(404)
            }
        }
        images.start()
        try {
            val store = Store(context)
            store.serverUrl = images.url("/").toString()
            val api = ApiClient(store)
            (1..12).map { index -> async { PosterLoader.load(api, "/image-$index", 20) } }.awaitAll()
            assertTrue(peak.get() <= 4)
            assertTrue(peak.get() > 1)
            val before = images.requestCount
            val first = launch { PosterLoader.load(api, "/shared", 20) }
            val second = async { PosterLoader.load(api, "/shared", 20) }
            kotlinx.coroutines.yield()
            first.cancelAndJoin()
            second.await()
            assertEquals(before + 1, images.requestCount)
        } finally { images.shutdown() }
    }
}
