package com.cairodrive.search;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicInteger;

/** Tiny non-Compose overlay for official Google Autocomplete predictions. */
public final class AutocompletePanel {
    public static final int NONE=-1, SEARCH_ALL=100, DISMISS=101;
    private static WeakReference<Activity> activityRef=new WeakReference<>(null);
    private static LinearLayout panel;
    private static final AtomicInteger selection=new AtomicInteger(NONE);
    private AutocompletePanel(){}
    private static int dp(Activity a,int v){return Math.max(1,Math.round(v*a.getResources().getDisplayMetrics().density));}
    private static GradientDrawable bg(Activity a,int color){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(a,14));d.setStroke(dp(a,1),0x55FFFFFF);return d;}
    public static void attach(Activity a){if(a==null)return;Activity old=activityRef.get();if(old!=a)panel=null;activityRef=new WeakReference<>(a);}
    private static String clean(String s){return s==null?"":s.replace('\t',' ').replace('\n',' ').replace('\r',' ').trim();}
    public static void show(final String payload){
        final Activity a=activityRef.get();if(a==null||a.isFinishing())return;
        a.runOnUiThread(()->{
            Activity c=activityRef.get();if(c==null||c.isFinishing())return;View root=c.findViewById(android.R.id.content);if(!(root instanceof ViewGroup))return;ViewGroup parent=(ViewGroup)root;
            if(panel==null||panel.getParent()!=parent){
                panel=new LinearLayout(c);panel.setOrientation(LinearLayout.VERTICAL);panel.setPadding(dp(c,8),dp(c,8),dp(c,8),dp(c,8));panel.setBackground(bg(c,0xF0222222));panel.setElevation(dp(c,16));
                ViewGroup.MarginLayoutParams lp=new ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT);lp.leftMargin=dp(c,10);lp.rightMargin=dp(c,10);lp.topMargin=dp(c,72);parent.addView(panel,lp);
            }
            panel.removeAllViews();selection.set(NONE);
            String[] lines=(payload==null?"":payload).split("\\n",-1);int shown=0;
            for(String line:lines){if(line==null||line.trim().isEmpty())continue;String[] p=line.split("\\t",3);if(p.length<2)continue;final int idx;try{idx=Integer.parseInt(p[0]);}catch(Throwable t){continue;}String main=clean(p[1]),sub=p.length>2?clean(p[2]):"";
                Button b=new Button(c);b.setAllCaps(false);b.setGravity(Gravity.CENTER_VERTICAL);b.setTextColor(Color.WHITE);b.setTextSize(16);b.setTypeface(Typeface.DEFAULT_BOLD);b.setText(main+(sub.isEmpty()?"":"\n"+sub));b.setBackground(bg(c,0xE6333333));b.setOnClickListener(v->{selection.set(idx);hide();});
                LinearLayout.LayoutParams blp=new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(c,64));blp.setMargins(0,0,0,dp(c,4));panel.addView(b,blp);shown++;if(shown>=5)break;
            }
            Button all=new Button(c);all.setAllCaps(false);all.setText("Search all results");all.setTextColor(0xFFFFE082);all.setTypeface(Typeface.DEFAULT_BOLD);all.setBackground(bg(c,0xE62B2B2B));all.setOnClickListener(v->{selection.set(SEARCH_ALL);hide();});panel.addView(all,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(c,48)));
            panel.setVisibility(View.VISIBLE);panel.bringToFront();
        });
    }
    public static int consumeSelection(){return selection.getAndSet(NONE);}
    public static void hide(){Activity a=activityRef.get();if(a==null)return;a.runOnUiThread(()->{if(panel!=null)panel.setVisibility(View.GONE);});}
}
