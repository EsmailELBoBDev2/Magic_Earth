package com.cairodrive.search;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.GZIPInputStream;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/**
 * Small cancellable HTTPS workers for CairoDrive.
 *
 * Security/performance invariants:
 * - only the Google Places and Routes HTTPS hosts used by CairoDrive are allowed;
 * - request and response bodies are bounded;
 * - each subsystem is serialized on one worker;
 * - abandoned completed states are reaped and total state count is bounded;
 * - cancellation disconnects the underlying socket.
 */
public final class AsyncHttp {
    private static final AtomicLong NEXT = new AtomicLong(1L);
    private static final ConcurrentHashMap<Long, State> STATES = new ConcurrentHashMap<>();
    private static final ExecutorService PLACES_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final ExecutorService TRAFFIC_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int MAX_REQUEST_BYTES = 512 * 1024;
    private static final int MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
    private static final int MAX_STATES = 32;
    private static final long DONE_REAP_MS = 30_000L;
    private static final long HARD_REAP_MS = 120_000L;

    private AsyncHttp() {}

    private static final class State {
        final long createdAtMs = System.currentTimeMillis();
        volatile boolean done;
        volatile boolean cancelled;
        volatile int status;
        volatile String body;
        volatile String error;
        volatile Future<?> future;
        volatile HttpsURLConnection connection;
    }

    public static long startPostJson(final String urlString, final String headersJson,
            final String body, final int connectTimeoutMs, final int readTimeoutMs) {
        return startPostJsonOn(PLACES_EXECUTOR, urlString, headersJson, body, connectTimeoutMs, readTimeoutMs);
    }

    public static long startTrafficPostJson(final String urlString, final String headersJson,
            final String body, final int connectTimeoutMs, final int readTimeoutMs) {
        return startPostJsonOn(TRAFFIC_EXECUTOR, urlString, headersJson, body, connectTimeoutMs, readTimeoutMs);
    }

    private static URL checkedUrl(String urlString) throws Exception {
        URL url = new URL(urlString);
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new SecurityException("HTTPS required");
        if (url.getPort() != -1 && url.getPort() != 443) throw new SecurityException("non-default HTTPS port rejected");
        String host = String.valueOf(url.getHost()).toLowerCase(java.util.Locale.US);
        String path = String.valueOf(url.getPath());
        boolean places = "places.googleapis.com".equals(host) && path.startsWith("/v1/places");
        boolean routes = "routes.googleapis.com".equals(host) && path.startsWith("/directions/v2");
        if (!places && !routes) throw new SecurityException("CairoDrive endpoint not allowlisted: " + host);
        return url;
    }

    private static void reapStates() {
        long now = System.currentTimeMillis();
        for (Map.Entry<Long, State> e : STATES.entrySet()) {
            State s = e.getValue();
            long age = now - s.createdAtMs;
            if ((s.done && age > DONE_REAP_MS) || age > HARD_REAP_MS) {
                if (STATES.remove(e.getKey(), s)) cancelState(s);
            }
        }
        if (STATES.size() >= MAX_STATES) throw new IllegalStateException("too many pending CairoDrive HTTP states");
    }

    private static void cancelState(State state) {
        state.cancelled = true;
        HttpsURLConnection conn = state.connection;
        if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
        Future<?> f = state.future;
        if (f != null) f.cancel(true);
        state.done = true;
    }

    private static String readBounded(InputStream raw, String contentEncoding, State state) throws Exception {
        if (raw == null) return "";
        InputStream stream = "gzip".equalsIgnoreCase(contentEncoding) ? new GZIPInputStream(raw) : raw;
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(4096);
        char[] buf = new char[4096];
        try {
            int n;
            while (!state.cancelled && (n = reader.read(buf)) != -1) {
                if (sb.length() + n > MAX_RESPONSE_CHARS) throw new IOException("response exceeds 4 MiB safety cap");
                sb.append(buf, 0, n);
            }
            return sb.toString();
        } finally {
            try { reader.close(); } catch (Throwable ignored) {}
        }
    }

    private static void applyHeaders(HttpsURLConnection conn, String headersJson) throws Exception {
        JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            // Prevent caller-supplied transport/header smuggling. ContentLength/Host are owned by URLConnection.
            String lower = key.toLowerCase(java.util.Locale.US);
            if ("host".equals(lower) || "content-length".equals(lower) || "connection".equals(lower)) continue;
            conn.setRequestProperty(key, headers.optString(key, ""));
        }
    }

    private static long startPostJsonOn(final ExecutorService executor, final String urlString,
            final String headersJson, final String body, final int connectTimeoutMs, final int readTimeoutMs) {
        reapStates();
        final long id = NEXT.getAndIncrement();
        final State state = new State();
        STATES.put(id, state);
        state.future = executor.submit(new Runnable() {
            @Override public void run() {
                HttpsURLConnection conn = null;
                try {
                    if (state.cancelled) return;
                    URL url = checkedUrl(urlString);
                    byte[] bytes = (body == null ? "{}" : body).getBytes(StandardCharsets.UTF_8);
                    if (bytes.length > MAX_REQUEST_BYTES) throw new IOException("request exceeds 512 KiB safety cap");
                    conn = (HttpsURLConnection) url.openConnection();
                    state.connection = conn;
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(Math.max(500, Math.min(15_000, connectTimeoutMs)));
                    conn.setReadTimeout(Math.max(500, Math.min(20_000, readTimeoutMs)));
                    conn.setUseCaches(false);
                    conn.setRequestProperty("Connection", "keep-alive");
                    conn.setRequestProperty("Accept", "application/json");
                    conn.setRequestProperty("Accept-Encoding", "gzip");
                    applyHeaders(conn, headersJson);
                    conn.setDoOutput(true);
                    OutputStream os = conn.getOutputStream();
                    try { os.write(bytes); os.flush(); } finally { os.close(); }
                    if (state.cancelled) return;
                    int status = conn.getResponseCode();
                    InputStream stream = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
                    String response = readBounded(stream, conn.getContentEncoding(), state);
                    if (!state.cancelled) { state.status = status; state.body = response; }
                } catch (Throwable t) {
                    if (!state.cancelled) state.error = t.getClass().getName() + ": " + String.valueOf(t.getMessage());
                } finally {
                    state.connection = null;
                    if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
                    state.done = true;
                }
            }
        });
        return id;
    }

    public static long startGetJson(final String urlString, final String headersJson,
            final int connectTimeoutMs, final int readTimeoutMs) {
        reapStates();
        final long id = NEXT.getAndIncrement();
        final State state = new State();
        STATES.put(id, state);
        state.future = PLACES_EXECUTOR.submit(new Runnable() {
            @Override public void run() {
                HttpsURLConnection conn = null;
                try {
                    if (state.cancelled) return;
                    URL url = checkedUrl(urlString);
                    conn = (HttpsURLConnection) url.openConnection();
                    state.connection = conn;
                    conn.setRequestMethod("GET");
                    conn.setConnectTimeout(Math.max(500, Math.min(15_000, connectTimeoutMs)));
                    conn.setReadTimeout(Math.max(500, Math.min(20_000, readTimeoutMs)));
                    conn.setUseCaches(false);
                    conn.setRequestProperty("Connection", "keep-alive");
                    conn.setRequestProperty("Accept", "application/json");
                    conn.setRequestProperty("Accept-Encoding", "gzip");
                    applyHeaders(conn, headersJson);
                    int status = conn.getResponseCode();
                    InputStream stream = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
                    String response = readBounded(stream, conn.getContentEncoding(), state);
                    if (!state.cancelled) { state.status = status; state.body = response; }
                } catch (Throwable t) {
                    if (!state.cancelled) state.error = t.getClass().getName() + ": " + String.valueOf(t.getMessage());
                } finally {
                    state.connection = null;
                    if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
                    state.done = true;
                }
            }
        });
        return id;
    }

    /** null while pending; otherwise consumes and returns OK:<status>\n<body>, ERR:<message>, or CANCELLED. */
    public static String poll(long id) {
        State state = STATES.get(id);
        if (state == null) return "CANCELLED";
        if (!state.done && !state.cancelled) return null;
        STATES.remove(id);
        if (state.cancelled) return "CANCELLED";
        if (state.error != null) return "ERR:" + state.error;
        return "OK:" + state.status + "\n" + (state.body == null ? "" : state.body);
    }

    public static void cancel(long id) {
        State state = STATES.remove(id);
        if (state != null) cancelState(state);
    }

    public static int pendingCount() { reapStates(); return STATES.size(); }
}
