package com.cairodrive.diag;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Debug;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Persistent low-overhead CairoDrive feature + mobile metrics logger. */
public final class DriveDiagnostics {
    private static final Object LOCK = new Object();
    private static final long MAX_FILE_BYTES = 8L * 1024L * 1024L;
    private static final long RETAIN_MS = 3L * 24L * 60L * 60L * 1000L;
    private static final long METRIC_PERIOD_SEC = 30L;
    private static final SimpleDateFormat DAY = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
    private static final SimpleDateFormat TS = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US);
    static { DAY.setTimeZone(TimeZone.getDefault()); TS.setTimeZone(TimeZone.getDefault()); }

    private static volatile boolean started;
    private static Context app;
    private static File dir;
    private static ScheduledExecutorService exec;
    private static BufferedWriter writer;
    private static File writerFile;
    private static long lastCpuMs;
    private static long lastWallMs;

    private DriveDiagnostics() {}

    public static void start(Context context, String appVersion) {
        if (context == null) return;
        synchronized (LOCK) {
            if (started) return;
            app = context.getApplicationContext();
            File base = app.getExternalFilesDir(null);
            if (base == null) base = app.getFilesDir();
            dir = new File(base, "cairodrive/logs");
            if (!dir.exists() && !dir.mkdirs()) return;
            cleanupOldFiles();
            lastCpuMs = Process.getElapsedCpuTime();
            lastWallMs = SystemClock.elapsedRealtime();
            exec = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "cairodrive-diag");
                t.setDaemon(true);
                return t;
            });
            started = true;
            enqueue("DIAG_START version=" + String.valueOf(appVersion) + " sdk=" + Build.VERSION.SDK_INT + " storage=" + dir.getAbsolutePath());
            exec.scheduleAtFixedRate(new Runnable() {
                @Override public void run() {
                    try { writeMetricSample(); } catch (Throwable ignored) {}
                }
            }, 5L, METRIC_PERIOD_SEC, TimeUnit.SECONDS);
        }
    }

    public static void write(String message) {
        if (!started || exec == null || message == null) return;
        enqueue(message);
    }

    public static String logDirectory() {
        File d = dir;
        return d == null ? "" : d.getAbsolutePath();
    }

    private static void enqueue(final String line) {
        ScheduledExecutorService e = exec;
        if (e == null || e.isShutdown()) return;
        try {
            e.execute(new Runnable() {
                @Override public void run() { appendLine(line); }
            });
        } catch (Throwable ignored) {}
    }

    private static File activeFile() {
        String day = DAY.format(new Date());
        File f = new File(dir, "cairodrive-" + day + ".log");
        if (f.exists() && f.length() >= MAX_FILE_BYTES) {
            if (writerFile != null && writerFile.equals(f)) closeWriter();
            File rolled = new File(dir, "cairodrive-" + day + "-" + System.currentTimeMillis() + ".log");
            try { if (f.renameTo(rolled)) f = new File(dir, "cairodrive-" + day + ".log"); } catch (Throwable ignored) {}
        }
        return f;
    }

    private static void appendLine(String line) {
        File d = dir;
        if (d == null) return;
        try {
            File f = activeFile();
            if (writer == null || writerFile == null || !writerFile.equals(f)) {
                closeWriter();
                writerFile = f;
                writer = new BufferedWriter(new FileWriter(f, true), 16384);
            }
            writer.write(TS.format(new Date()));
            writer.write(' ');
            writer.write(line.replace('\n', ' ').replace('\r', ' '));
            writer.newLine();
            // Flush each event so crash diagnostics survive process death. The file stays open,
            // avoiding repeated open/close churn while keeping durability.
            writer.flush();
        } catch (Throwable ignored) { closeWriter(); }
    }

    private static void closeWriter() {
        try { if (writer != null) writer.close(); } catch (Throwable ignored) {}
        writer = null;
        writerFile = null;
    }

    private static void cleanupOldFiles() {
        File d = dir;
        if (d == null) return;
        File[] files = d.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - RETAIN_MS;
        for (File f : files) {
            if (f == null || !f.isFile()) continue;
            String n = f.getName();
            if (!n.startsWith("cairodrive-") || !n.endsWith(".log")) continue;
            try { if (f.lastModified() < cutoff) f.delete(); } catch (Throwable ignored) {}
        }
    }

    private static void writeMetricSample() {
        Context c = app;
        if (c == null) return;
        long nowWall = SystemClock.elapsedRealtime();
        long nowCpu = Process.getElapsedCpuTime();
        long dw = Math.max(1L, nowWall - lastWallMs);
        long dc = Math.max(0L, nowCpu - lastCpuMs);
        double cpuCorePct = dc * 100.0 / dw;
        lastWallMs = nowWall;
        lastCpuMs = nowCpu;

        long pssKb = Debug.getPss();
        long nativeKb = Debug.getNativeHeapAllocatedSize() / 1024L;
        Runtime rt = Runtime.getRuntime();
        long javaUsedKb = (rt.totalMemory() - rt.freeMemory()) / 1024L;
        long javaMaxKb = rt.maxMemory() / 1024L;

        int batteryPct = -1, tempDeciC = -1, voltageMv = -1, plugged = -1, batteryStatus = -1;
        try {
            Intent b = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b != null) {
                int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                if (level >= 0 && scale > 0) batteryPct = Math.round(level * 100f / scale);
                tempDeciC = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
                voltageMv = b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1);
                plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1);
                batteryStatus = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            }
        } catch (Throwable ignored) {}

        int thermal = -1;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                PowerManager pm = (PowerManager)c.getSystemService(Context.POWER_SERVICE);
                if (pm != null) thermal = pm.getCurrentThermalStatus();
            } catch (Throwable ignored) {}
        }

        StringBuilder s = new StringBuilder(256);
        s.append("METRIC cpuCorePct=").append(String.format(Locale.US, "%.1f", cpuCorePct));
        s.append(" pssKb=").append(pssKb);
        s.append(" nativeKb=").append(nativeKb);
        s.append(" javaUsedKb=").append(javaUsedKb);
        s.append(" javaMaxKb=").append(javaMaxKb);
        s.append(" batteryPct=").append(batteryPct);
        s.append(" tempC=").append(tempDeciC >= 0 ? String.format(Locale.US, "%.1f", tempDeciC / 10.0) : "-1");
        s.append(" voltageMv=").append(voltageMv);
        s.append(" plugged=").append(plugged);
        s.append(" batteryStatus=").append(batteryStatus);
        s.append(" thermal=").append(thermal);
        s.append(" uptimeSec=").append(SystemClock.elapsedRealtime() / 1000L);
        appendLine(s.toString());
        cleanupOldFiles();
    }
}
