package com.widetv.app.net

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test

class CallsTest {
    @Test fun cancellationStopsAnOutstandingHttpCall() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.start()
        try {
            val call = OkHttpClient().newCall(Request.Builder().url(server.url("/slow")).build())
            var fallback = false
            val job = launch(Dispatchers.IO) {
                catchingNetwork { call.consume { it.body!!.string() } }.getOrElse { fallback = true }
            }
            assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            job.cancelAndJoin()
            assertTrue(call.isCanceled())
            assertFalse("Cancellation must not become an offline state", fallback)
        } finally { server.shutdown() }
    }

    @Test fun cancellationAlsoStopsReadingTheResponseBody() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("long body").setBodyDelay(2, TimeUnit.SECONDS))
        server.start()
        try {
            val call = OkHttpClient().newCall(Request.Builder().url(server.url("/slow-body")).build())
            val reading = java.util.concurrent.CountDownLatch(1)
            val job = launch(Dispatchers.IO) { call.consume { reading.countDown(); it.body!!.string() } }
            assertTrue(reading.await(5, TimeUnit.SECONDS))
            job.cancelAndJoin()
            assertTrue(call.isCanceled())
        } finally { server.shutdown() }
    }
}
