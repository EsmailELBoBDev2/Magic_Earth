package com.cairodrive.bootstrap;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;

/**
 * Early, non-exported bootstrap for the CairoDrive instrumentation payload.
 * ContentProviders are created before Application.onCreate, which lets us load
 * Frida Gadget without patching version-specific libflutter.so bytes.
 */
public final class CairoDriveBootstrapProvider extends ContentProvider {
    private static volatile boolean loaded;

    @Override public boolean onCreate() {
        if (!loaded) {
            synchronized (CairoDriveBootstrapProvider.class) {
                if (!loaded) {
                    try {
                        System.loadLibrary("gadget");
                        loaded = true;
                    } catch (Throwable t) {
                        android.util.Log.e("cairodrive", "BOOTSTRAP_GADGET_LOAD_FAILED " + t);
                    }
                }
            }
        }
        return true;
    }
    @Override public String getType(Uri uri) { return null; }
    @Override public Cursor query(Uri uri, String[] p, String s, String[] a, String so) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String s, String[] a) { return 0; }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
