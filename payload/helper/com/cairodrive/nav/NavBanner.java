package com.cairodrive.nav;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.content.Context;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/** Compact fail-open CairoDrive supplemental overlay. Stock Magic Earth owns normal nav UI. */
public final class NavBanner {
    public static final int ACTION_NONE = 0;
    public static final int ACTION_REPEAT = 1;
    public static final int ACTION_REPORT = 2;
    public static final int ACTION_MEDIA_PAUSE = 3;
    public static final int ACTION_PAUSE = 3;

    private static WeakReference<Activity> activityRef = new WeakReference<>(null);
    private static LinearLayout panel, controls;
    private static ImageView maneuver, lanes;
    private static Bitmap ownedManeuverBitmap, ownedLaneBitmap;
    private static TextView title, subtitle, detail;
    private static final AtomicInteger pendingAction = new AtomicInteger(ACTION_NONE);
    private static final AtomicInteger pendingReportUid = new AtomicInteger(0);

    private NavBanner() {}
    private static int dp(Activity a, int v) { return Math.round(v * a.getResources().getDisplayMetrics().density); }

    public static void attach(Activity activity) {
        if (activity == null) return;
        Activity old = activityRef.get();
        if (old != activity) {
            panel=null; controls=null; maneuver=null; lanes=null; title=null; subtitle=null; detail=null;
            Bitmap m=ownedManeuverBitmap; ownedManeuverBitmap=null;
            if (m!=null && !m.isRecycled()) try { m.recycle(); } catch(Throwable ignored) {}
            Bitmap b=ownedLaneBitmap; ownedLaneBitmap=null;
            if (b!=null && !b.isRecycled()) try { b.recycle(); } catch(Throwable ignored) {}
        }
        activityRef = new WeakReference<>(activity);
        ensureControls();
    }

    private static GradientDrawable bg(int color, int strokeColor, int strokeDp, Activity a) {
        GradientDrawable d=new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(a,14)); d.setStroke(dp(a,strokeDp),strokeColor); return d;
    }

    private static Button button(Activity a, String label) {
        Button b=new Button(a); b.setText(label); b.setAllCaps(false); b.setTextSize(15); b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(Color.WHITE); b.setBackground(bg(0xD9252525,0x66FFFFFF,1,a)); b.setMinHeight(dp(a,44)); b.setPadding(dp(a,8),0,dp(a,8),0); return b;
    }

    private static void ensureControls() {
        final Activity a=activityRef.get(); if (a==null || a.isFinishing()) return;
        a.runOnUiThread(() -> {
            Activity c=activityRef.get(); if(c==null||c.isFinishing()) return;
            View root=c.findViewById(android.R.id.content); if(!(root instanceof ViewGroup)) return;
            ViewGroup parent=(ViewGroup)root;
            if(controls!=null && controls.getParent()==parent) return;
            if(controls!=null && controls.getParent() instanceof ViewGroup) ((ViewGroup)controls.getParent()).removeView(controls);
            controls=new LinearLayout(c); controls.setOrientation(LinearLayout.HORIZONTAL); controls.setGravity(Gravity.CENTER);
            Button more=button(c,"⋯ CairoDrive");
            controls.addView(more,new LinearLayout.LayoutParams(dp(c,132),dp(c,44)));
            more.setOnClickListener(v -> showActionChoices());
            ViewGroup.MarginLayoutParams lp=new ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin=dp(c,10); lp.bottomMargin=dp(c,12);
            parent.addView(controls,lp); controls.setY(Math.max(0,parent.getHeight()-dp(c,66))); controls.bringToFront();
        });
    }

    private static void showActionChoices() {
        final Activity a=activityRef.get(); if(a==null||a.isFinishing()) return;
        a.runOnUiThread(() -> new AlertDialog.Builder(a)
            .setTitle("CairoDrive")
            .setItems(new String[]{"Report road event","Pause media","Repeat instruction"},(d,which)->{
                if(which==0){pendingReportUid.set(0);pendingAction.set(ACTION_REPORT);}
                else if(which==1)pendingAction.set(ACTION_MEDIA_PAUSE);
                else if(which==2)pendingAction.set(ACTION_REPEAT);
            }).setNegativeButton("Cancel",null).show());
    }

    /** spec: one UTF-8 line per option, formatted as integer-id|label. */
    public static void showReportChoices(final String spec) {
        final Activity a=activityRef.get(); if(a==null||a.isFinishing()) return;
        final ArrayList<Integer> ids=new ArrayList<>(); final ArrayList<String> labels=new ArrayList<>();
        if(spec!=null) for(String line:spec.split("\\n")){
            int bar=line.indexOf('|'); if(bar<=0||bar>=line.length()-1)continue;
            try{ids.add(Integer.parseInt(line.substring(0,bar).trim()));labels.add(line.substring(bar+1).trim());}catch(Throwable ignored){}
        }
        if(labels.isEmpty()) return;
        a.runOnUiThread(() -> new AlertDialog.Builder(a).setTitle("Report road event")
            .setItems(labels.toArray(new String[0]),(d,which)->{if(which>=0&&which<ids.size()){pendingReportUid.set(ids.get(which));pendingAction.set(ACTION_REPORT);}})
            .setNegativeButton("Cancel",null).show());
    }

    public static boolean pauseMedia() {
        final Activity a=activityRef.get(); if(a==null) return false;
        try {
            AudioManager am=(AudioManager)a.getSystemService(Context.AUDIO_SERVICE);
            if(am!=null){ long t=android.os.SystemClock.uptimeMillis(); am.dispatchMediaKeyEvent(new KeyEvent(t,t,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_MEDIA_PAUSE,0)); am.dispatchMediaKeyEvent(new KeyEvent(t,t,KeyEvent.ACTION_UP,KeyEvent.KEYCODE_MEDIA_PAUSE,0)); return true; }
        } catch(Throwable ignored) {}
        return false;
    }

    public static int consumeAction(){ return pendingAction.getAndSet(ACTION_NONE); }
    public static int consumeReportUid(){ return pendingReportUid.getAndSet(0); }

    public static void show(final String primary, final String secondary, final String tertiary, final int importance, final Bitmap laneBitmap, final Bitmap maneuverBitmap) {
        final Activity a=activityRef.get(); if(a==null||a.isFinishing()) return;
        a.runOnUiThread(() -> {
            Activity current=activityRef.get(); if(current==null||current.isFinishing()) return;
            View root=current.findViewById(android.R.id.content); if(!(root instanceof ViewGroup)) return; ViewGroup parent=(ViewGroup)root;
            if(panel==null || panel.getParent()!=parent){
                if(panel!=null && panel.getParent() instanceof ViewGroup) ((ViewGroup)panel.getParent()).removeView(panel);
                panel=new LinearLayout(current); panel.setOrientation(LinearLayout.VERTICAL); panel.setGravity(Gravity.CENTER_HORIZONTAL);
                panel.setPadding(dp(current,12),dp(current,8),dp(current,12),dp(current,8)); panel.setBackground(bg(0xE6202020,0xAAFFFFFF,1,current)); panel.setElevation(dp(current,10));
                maneuver=new ImageView(current); maneuver.setAdjustViewBounds(true); maneuver.setScaleType(ImageView.ScaleType.CENTER_INSIDE); maneuver.setVisibility(View.GONE);
                panel.addView(maneuver,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(current,82)));
                lanes=new ImageView(current); lanes.setAdjustViewBounds(true); lanes.setScaleType(ImageView.ScaleType.CENTER_INSIDE); lanes.setVisibility(View.GONE);
                panel.addView(lanes,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(current,62)));
                title=new TextView(current); title.setTextColor(Color.WHITE); title.setTypeface(Typeface.DEFAULT_BOLD); title.setTextSize(20f); title.setGravity(Gravity.CENTER); title.setMaxLines(2);
                subtitle=new TextView(current); subtitle.setTextColor(0xFFFFE082); subtitle.setTypeface(Typeface.DEFAULT_BOLD); subtitle.setTextSize(14f); subtitle.setGravity(Gravity.CENTER); subtitle.setMaxLines(2);
                detail=new TextView(current); detail.setTextColor(0xFFE0E0E0); detail.setTextSize(12f); detail.setGravity(Gravity.CENTER); detail.setMaxLines(3);
                panel.addView(title,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT));
                panel.addView(subtitle,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT));
                panel.addView(detail,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT));
                ViewGroup.MarginLayoutParams lp=new ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT); lp.leftMargin=dp(current,18);lp.rightMargin=dp(current,18);lp.topMargin=dp(current,54); parent.addView(panel,lp);
            }
            if(maneuverBitmap!=ownedManeuverBitmap){Bitmap old=ownedManeuverBitmap;ownedManeuverBitmap=maneuverBitmap;if(old!=null&&old!=maneuverBitmap&&!old.isRecycled())try{old.recycle();}catch(Throwable ignored){}}
            if(maneuver!=null){maneuver.setImageBitmap(maneuverBitmap);maneuver.setVisibility(maneuverBitmap==null?View.GONE:View.VISIBLE);}
            if(laneBitmap!=ownedLaneBitmap){Bitmap old=ownedLaneBitmap;ownedLaneBitmap=laneBitmap;if(old!=null&&old!=laneBitmap&&!old.isRecycled())try{old.recycle();}catch(Throwable ignored){}}
            if(lanes!=null){lanes.setImageBitmap(laneBitmap);lanes.setVisibility(laneBitmap==null?View.GONE:View.VISIBLE);}
            title.setText(primary==null?"":primary); subtitle.setText(secondary==null?"":secondary); detail.setText(tertiary==null?"":tertiary);
            subtitle.setVisibility(secondary==null||secondary.isEmpty()?View.GONE:View.VISIBLE); detail.setVisibility(tertiary==null||tertiary.isEmpty()?View.GONE:View.VISIBLE);
            if(panel.getBackground() instanceof GradientDrawable)((GradientDrawable)panel.getBackground()).setStroke(dp(current,importance>=3?3:1),importance>=3?0xFFFFC107:0xAAFFFFFF);
            panel.setVisibility(View.VISIBLE); panel.bringToFront(); ensureControls(); if(controls!=null)controls.bringToFront();
        });
    }

    public static void hide(){ final Activity a=activityRef.get(); if(a==null)return; a.runOnUiThread(()->{if(panel!=null)panel.setVisibility(View.GONE);if(maneuver!=null){maneuver.setImageBitmap(null);maneuver.setVisibility(View.GONE);}if(lanes!=null){lanes.setImageBitmap(null);lanes.setVisibility(View.GONE);}Bitmap m=ownedManeuverBitmap;ownedManeuverBitmap=null;if(m!=null&&!m.isRecycled())try{m.recycle();}catch(Throwable ignored){}Bitmap old=ownedLaneBitmap;ownedLaneBitmap=null;if(old!=null&&!old.isRecycled())try{old.recycle();}catch(Throwable ignored){} ensureControls();}); }
}
