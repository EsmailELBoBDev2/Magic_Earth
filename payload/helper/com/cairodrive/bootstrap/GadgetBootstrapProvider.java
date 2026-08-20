package com.cairodrive.bootstrap;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

/**
 * Early, private process bootstrap for Frida Gadget.
 *
 * Using a ContentProvider removes the old exact-libflutter binary patch and is
 * therefore resilient to ordinary Flutter engine updates. The provider is
 * exported=false and has no data surface; it exists only to load libgadget.so
 * before the app's normal UI/navigation code begins running.
 */
public final class GadgetBootstrapProvider extends ContentProvider {
    private static final String TAG = "cairodrive";
    private static volatile boolean attempted;

    private static void ensureLoaded() {
        if (attempted) return;
        synchronized (GadgetBootstrapProvider.class) {
            if (attempted) return;
            attempted = true;
            try {
                System.loadLibrary("gadget");
                Log.i(TAG, "GADGET_BOOTSTRAP loaded=1 source=provider");
            } catch (Throwable t) {
                // Fail-open: stock Magic Earth/CairoDrive should still launch.
                Log.e(TAG, "GADGET_BOOTSTRAP loaded=0 " + t.getClass().getSimpleName());
            }
        }
    }

    @Override public boolean onCreate() { ensureLoaded(); return true; }
    @Override public Cursor query(Uri uri, String[] projection, String selection,
                                  String[] selectionArgs, String sortOrder) { return null; }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection,
                                String[] selectionArgs) { return 0; }
}
