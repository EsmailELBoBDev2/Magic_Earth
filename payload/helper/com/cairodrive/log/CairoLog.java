package com.cairodrive.log;

import android.content.Context;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPOutputStream;

/**
 * Best-effort local mirror of CairoDrive's logcat messages.
 * - logcat remains the live/authoritative stream
 * - files use fixed 3-day UTC buckets
 * - each bucket is segmented at ~24 MiB and closed segments are gzip-compressed
 * - last 30 days are retained
 * - file I/O never runs on the caller/UI thread
 */
public final class CairoLog {
    private static final long BUCKET_MS = 3L * 24L * 60L * 60L * 1000L;
    private static final long RETAIN_MS = 30L * 24L * 60L * 60L * 1000L;
    private static final long MAX_SEGMENT_BYTES = 24L * 1024L * 1024L;
    // Logging is best-effort. A single-thread executor with an unbounded queue can
    // consume arbitrary memory during a log storm, so keep a small bounded backlog
    // and discard the oldest pending log batch when disk I/O cannot keep up.
    private static final ExecutorService IO = new ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<Runnable>(128), r -> {
            Thread t = new Thread(r, "cairodrive-log-writer");
            t.setDaemon(true);
            return t;
        }, new ThreadPoolExecutor.DiscardOldestPolicy());
    private static volatile File dir;
    private static volatile long lastPruneAt;
    private static File openFile;
    private static BufferedWriter openWriter;
    private static long openBucketStart = -1L;
    private static int openSegment = 0;
    private static int pendingLines;
    private static long lastFlushAt;

    private CairoLog() {}

    public static void init(Context context) {
        if (context == null) return;
        try {
            Context app = context.getApplicationContext();
            File root = app.getExternalFilesDir(null);
            if (root == null) return;
            File d = new File(new File(root, "cairodrive"), "logs");
            if (!d.exists()) d.mkdirs();
            dir = d;
            IO.execute(() -> prune(System.currentTimeMillis()));
        } catch (Throwable ignored) {}
    }

    public static void mirror(String line) {
        if (line == null) return;
        mirrorBatch(line);
    }

    /** Accept many newline-separated logcat lines in one JS->Java bridge call. */
    public static void mirrorBatch(String lines) {
        final File d = dir;
        if (d == null || lines == null || lines.isEmpty()) return;
        final long now = System.currentTimeMillis();
        final String copy = lines.length() > 131072 ? lines.substring(0, 131072) : lines;
        IO.execute(() -> {
            String[] rows = copy.split("\\n", -1);
            for (String row : rows) {
                if (row == null || row.isEmpty()) continue;
                append(d, System.currentTimeMillis(), row.length() > 8192 ? row.substring(0, 8192) : row);
            }
            if (now - lastPruneAt > 6L * 60L * 60L * 1000L) prune(now);
        });
    }

    private static long bucketStart(long now) { return (now / BUCKET_MS) * BUCKET_MS; }

    private static String bucketPrefix(long start) {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return "cairodrive-" + f.format(new Date(start)) + "-3d-";
    }

    private static File segmentFile(File d, long bucket, int segment) {
        return new File(d, bucketPrefix(bucket) + String.format(Locale.US, "%03d", segment) + ".log");
    }

    private static int findAppendSegment(File d, long bucket) {
        String prefix = bucketPrefix(bucket);
        int max = 0;
        File[] files = d.listFiles();
        if (files != null) {
            for (File f : files) {
                String n = f.getName();
                if (!n.startsWith(prefix)) continue;
                int a = prefix.length(), b = n.indexOf('.', a);
                if (b <= a) continue;
                try { max = Math.max(max, Integer.parseInt(n.substring(a, b))); } catch (Throwable ignored) {}
            }
        }
        if (max <= 0) return 1;
        File plain = segmentFile(d, bucket, max);
        if (plain.isFile() && plain.length() < MAX_SEGMENT_BYTES) return max;
        return max + 1;
    }

    private static void ensureWriter(File d, long now) throws Exception {
        long bucket = bucketStart(now);
        if (openWriter != null && openBucketStart == bucket && openFile != null && openFile.length() < MAX_SEGMENT_BYTES) return;
        File previous = closeWriter();
        if (previous != null && previous.isFile() && previous.length() > 0) gzip(previous);
        openBucketStart = bucket;
        openSegment = findAppendSegment(d, bucket);
        openFile = segmentFile(d, bucket, openSegment);
        openWriter = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(openFile, true), StandardCharsets.UTF_8), 32768);
        lastFlushAt = now;
    }

    private static void append(File d, long now, String line) {
        try {
            ensureWriter(d, now);
            openWriter.write(Long.toString(now));
            openWriter.write(' ');
            openWriter.write(line.replace('\n', ' '));
            openWriter.newLine();
            pendingLines++;
            if (pendingLines >= 16 || now - lastFlushAt >= 2000L) {
                openWriter.flush();
                pendingLines = 0;
                lastFlushAt = now;
            }
            if (openFile != null && openFile.length() >= MAX_SEGMENT_BYTES) {
                File full = closeWriter();
                if (full != null) gzip(full);
            }
        } catch (Throwable ignored) {}
    }

    /** Returns the file that was closed, if any. */
    private static File closeWriter() {
        File closed = openFile;
        try {
            if (openWriter != null) {
                openWriter.flush();
                openWriter.close();
            }
        } catch (Throwable ignored) {
        } finally {
            openWriter = null;
            openFile = null;
            openBucketStart = -1L;
            openSegment = 0;
            pendingLines = 0;
        }
        return closed;
    }

    private static void gzip(File src) {
        if (src == null || !src.isFile() || src.getName().endsWith(".gz")) return;
        File dst = new File(src.getParentFile(), src.getName() + ".gz");
        if (dst.exists()) { src.delete(); return; }
        byte[] buf = new byte[32768];
        try (BufferedInputStream in = new BufferedInputStream(new FileInputStream(src));
             GZIPOutputStream gz = new GZIPOutputStream(new BufferedOutputStream(new FileOutputStream(dst)))) {
            int n;
            while ((n = in.read(buf)) > 0) gz.write(buf, 0, n);
            gz.finish();
            src.delete();
        } catch (Throwable ignored) {
            try { if (dst.exists()) dst.delete(); } catch (Throwable ignored2) {}
        }
    }

    private static void prune(long now) {
        lastPruneAt = now;
        File d = dir;
        if (d == null) return;
        try {
            File[] files = d.listFiles();
            if (files == null) return;
            for (File f : files) {
                if (f.isFile() && f.getName().startsWith("cairodrive-") && now - f.lastModified() > RETAIN_MS) f.delete();
            }
        } catch (Throwable ignored) {}
    }
}
