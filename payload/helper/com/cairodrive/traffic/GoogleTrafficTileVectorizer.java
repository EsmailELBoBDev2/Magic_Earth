package com.cairodrive.traffic;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Google traffic-overlay raster -> sparse traffic vectors.
 * Runs entirely off the GEM/render thread. It intentionally keeps only SLOW/JAM
 * cells and never returns free-flow/green roads.
 */
public final class GoogleTrafficTileVectorizer {
    private static final AtomicLong NEXT = new AtomicLong(1L);
    private static final ConcurrentHashMap<Long, State> STATES = new ConcurrentHashMap<Long, State>();
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private static final int MAX_STATES = 4;
    private static final int MAX_TILE_BYTES = 1024 * 1024;
    private static final int MAX_PATHS = 36;
    private static final int MAX_POINTS_PER_PATH = 96;
    private static final int CACHE_SOFT_LIMIT = 32;
    private static final int CACHE_HARD_LIMIT = 48;
    private static final long DEFAULT_CACHE_MS = 60000L;
    private static final long AUTH_BACKOFF_MS = 300000L;
    private static final long QUOTA_BACKOFF_MS = 180000L;

    private static final Object SESSION_LOCK = new Object();
    private static String sessionKey = "";
    private static volatile String lastAttemptKey = "";
    private static String sessionToken = "";
    private static long sessionExpiryMs = 0L;
    private static volatile long blockedUntilMs = 0L;
    private static final ConcurrentHashMap<String, CacheEntry> CACHE = new ConcurrentHashMap<String, CacheEntry>();

    private GoogleTrafficTileVectorizer() {}

    private static final class State {
        volatile boolean done, cancelled;
        volatile String body, error;
        volatile Future<?> future;
        volatile HttpsURLConnection connection;
    }
    private static final class Tile {
        final int z,x,y; final String key;
        Tile(int z,int x,int y){this.z=z;this.x=x;this.y=y;this.key=z+"/"+x+"/"+y;}
    }
    private static final class Pt {
        final double lat,lon;
        Pt(double lat,double lon){this.lat=lat;this.lon=lon;}
    }
    private static final class Seg {
        final int sev; // 1 slow, 2 jam
        List<Pt> pts;
        double lengthM;
        Seg(int sev,List<Pt> pts){this.sev=sev;this.pts=pts;this.lengthM=length(pts);}
    }
    private static final class CacheEntry {
        final List<Seg> segs; final String etag; final long expiresAt; volatile long lastAccessMs;
        CacheEntry(List<Seg> segs,String etag,long expiresAt,long lastAccessMs){this.segs=segs;this.etag=etag;this.expiresAt=expiresAt;this.lastAccessMs=lastAccessMs;}
    }

    public static long start(final String apiKey, final String androidPackage, final String androidCert,
                             final double latitude, final double longitude, final double bearingDeg,
                             final double speedMps, final int requestedZoom,
                             final int connectTimeoutMs, final int readTimeoutMs) {
        final String key = apiKey == null ? "" : apiKey.trim();
        final String pkg = androidPackage == null ? "" : androidPackage.trim();
        final String cert = androidCert == null ? "" : androidCert.trim();
        if (key.length() < 20) throw new IllegalArgumentException("Map Tiles API key missing");
        if (!validCoord(latitude,longitude)) throw new IllegalArgumentException("invalid coordinate");
        if (!key.equals(lastAttemptKey)) { synchronized(SESSION_LOCK){ if(!key.equals(lastAttemptKey)){blockedUntilMs=0L;lastAttemptKey=key;sessionKey="";sessionToken="";sessionExpiryMs=0L;CACHE.clear();} } }
        reap();
        if (STATES.size() >= MAX_STATES) throw new IllegalStateException("too many traffic vector requests");
        final State state = new State();
        final long id = NEXT.getAndIncrement(); STATES.put(id,state);
        state.future = EXEC.submit(new Runnable(){@Override public void run(){
            try {
                if (state.cancelled) return;
                long now=System.currentTimeMillis();
                if (now < blockedUntilMs) throw new IllegalStateException("traffic provider cooldown");
                String session = ensureSession(state,key,pkg,cert,connectTimeoutMs,readTimeoutMs);
                int z = requestedZoom==15 ? 15 : 16;
                Tile center = tileFor(latitude,longitude,z);
                List<Tile> tiles = window(center,bearingDeg,speedMps);
                ArrayList<Seg> all = new ArrayList<Seg>();
                int fetched=0,cached=0;
                for (Tile t: tiles) {
                    if (state.cancelled) return;
                    FetchResult fr = fetchTile(state,key,pkg,cert,session,t,connectTimeoutMs,readTimeoutMs);
                    if (fr.cached) cached++; else fetched++;
                    all.addAll(fr.segs);
                }
                List<Seg> merged = mergeAndBudget(all,MAX_PATHS);
                JSONObject out = new JSONObject();
                out.put("z",z); out.put("center",center.key); out.put("tileCount",tiles.size());
                out.put("fetched",fetched); out.put("cached",cached);
                JSONArray ja = new JSONArray();
                for (Seg s: merged) {
                    JSONObject o=new JSONObject(); o.put("speed",s.sev>=2?"TRAFFIC_JAM":"SLOW");
                    o.put("lengthM",Math.round(s.lengthM));
                    JSONArray ca=new JSONArray();
                    for(Pt p:s.pts){JSONArray q=new JSONArray();q.put(round6(p.lat));q.put(round6(p.lon));ca.put(q);} o.put("coords",ca); ja.put(o);
                }
                out.put("segments",ja);
                state.body=out.toString();
            } catch(Throwable t) {
                if(!state.cancelled) state.error=t.getClass().getSimpleName()+": "+String.valueOf(t.getMessage());
            } finally { state.done=true; }
        }});
        return id;
    }

    public static String poll(long id){
        State s=STATES.get(id); if(s==null)return "CANCELLED"; if(!s.done&&!s.cancelled)return null;
        STATES.remove(id); if(s.cancelled)return "CANCELLED"; if(s.error!=null)return "ERR:"+s.error; return "OK:"+(s.body==null?"{}":s.body);
    }
    public static void cancel(long id){State s=STATES.remove(id);if(s==null)return;s.cancelled=true;try{HttpsURLConnection c=s.connection;if(c!=null)c.disconnect();}catch(Throwable ignored){}Future<?> f=s.future;if(f!=null)f.cancel(true);s.done=true;}
    private static void reap(){
        for(Map.Entry<Long,State> e:STATES.entrySet()){State s=e.getValue();if(s.done||s.cancelled)STATES.remove(e.getKey(),s);}
        long now=System.currentTimeMillis();
        for(Map.Entry<String,CacheEntry> e:CACHE.entrySet())if(now-e.getValue().expiresAt>180000L)CACHE.remove(e.getKey(),e.getValue());
        if(CACHE.size()>CACHE_HARD_LIMIT){
            ArrayList<Map.Entry<String,CacheEntry>> entries=new ArrayList<Map.Entry<String,CacheEntry>>(CACHE.entrySet());
            Collections.sort(entries,new Comparator<Map.Entry<String,CacheEntry>>(){public int compare(Map.Entry<String,CacheEntry>a,Map.Entry<String,CacheEntry>b){return Long.compare(a.getValue().lastAccessMs,b.getValue().lastAccessMs);}});
            int remove=Math.max(0,entries.size()-CACHE_SOFT_LIMIT);
            for(int i=0;i<remove;i++)CACHE.remove(entries.get(i).getKey(),entries.get(i).getValue());
        }
    }

    private static String ensureSession(State state,String key,String pkg,String cert,int ct,int rt) throws Exception {
        synchronized(SESSION_LOCK){
            long now=System.currentTimeMillis();
            if(key.equals(sessionKey)&&sessionToken.length()>10&&now+60000L<sessionExpiryMs)return sessionToken;
            URL u=new URL("https://tile.googleapis.com/v1/createSession?key="+enc(key));
            HttpsURLConnection c=(HttpsURLConnection)u.openConnection(); state.connection=c;
            try{
                c.setRequestMethod("POST"); c.setConnectTimeout(clamp(ct,500,15000)); c.setReadTimeout(clamp(rt,500,20000));
                c.setUseCaches(false); c.setInstanceFollowRedirects(false); c.setDoOutput(true);
                c.setRequestProperty("Content-Type","application/json"); c.setRequestProperty("Accept","application/json"); setMobileHeaders(c,pkg,cert);
                byte[] body=("{\"mapType\":\"roadmap\",\"language\":\"en-US\",\"region\":\"EG\",\"layerTypes\":[\"layerTraffic\"],\"overlay\":true,\"scale\":\"scaleFactor1x\"}").getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(body.length); OutputStream os=c.getOutputStream();os.write(body);os.close();
                int status=c.getResponseCode(); byte[] raw=readLimited(status>=200&&status<300?c.getInputStream():c.getErrorStream(),256*1024);
                String text=new String(raw,StandardCharsets.UTF_8);
                if(status==403){blockedUntilMs=now+AUTH_BACKOFF_MS;throw new SecurityException("Map Tiles API forbidden");}
                if(status==429){blockedUntilMs=now+QUOTA_BACKOFF_MS;throw new IllegalStateException("Map Tiles API quota");}
                if(status<200||status>=300)throw new IllegalStateException("createSession HTTP "+status+" "+truncate(text,120));
                JSONObject j=new JSONObject(text);String token=j.optString("session","");long expirySec=0L;try{expirySec=Long.parseLong(j.optString("expiry","0"));}catch(Exception ignored){}
                if(token.length()<10)throw new IllegalStateException("createSession missing token");
                sessionKey=key;sessionToken=token;sessionExpiryMs=expirySec>0?expirySec*1000L:now+12L*24L*3600L*1000L;
                CACHE.clear();return token;
            } finally {if(state.connection==c)state.connection=null;try{c.disconnect();}catch(Throwable ignored){}}
        }
    }

    private static final class FetchResult { final List<Seg> segs; final boolean cached; FetchResult(List<Seg>s,boolean c){segs=s;cached=c;} }
    private static FetchResult fetchTile(State state,String key,String pkg,String cert,String session,Tile t,int ct,int rt)throws Exception{
        long now=System.currentTimeMillis(); CacheEntry ce=CACHE.get(t.key); if(ce!=null){ce.lastAccessMs=now;if(now<ce.expiresAt)return new FetchResult(copySegs(ce.segs),true);}
        String url="https://tile.googleapis.com/v1/2dtiles/"+t.z+"/"+t.x+"/"+t.y+"?session="+enc(session)+"&key="+enc(key);
        HttpsURLConnection c=(HttpsURLConnection)new URL(url).openConnection(); state.connection=c;
        try{
            c.setRequestMethod("GET");c.setConnectTimeout(clamp(ct,500,15000));c.setReadTimeout(clamp(rt,500,20000));c.setUseCaches(false);c.setInstanceFollowRedirects(false);c.setRequestProperty("Accept","image/png");setMobileHeaders(c,pkg,cert);
            if(ce!=null&&ce.etag!=null&&ce.etag.length()>0)c.setRequestProperty("If-None-Match",ce.etag);
            int status=c.getResponseCode(); String cacheControl=c.getHeaderField("Cache-Control"); long ttl=parseMaxAgeMs(cacheControl); if(cacheControl!=null&&cacheControl.toLowerCase().contains("no-store"))ttl=0L; else if(ttl<0)ttl=DEFAULT_CACHE_MS;
            if(status==304&&ce!=null){CacheEntry n=new CacheEntry(ce.segs,ce.etag,now+ttl,now);CACHE.put(t.key,n);return new FetchResult(copySegs(ce.segs),true);}
            if(status==403){blockedUntilMs=now+AUTH_BACKOFF_MS;throw new SecurityException("tile forbidden");}
            if(status==429){blockedUntilMs=now+QUOTA_BACKOFF_MS;throw new IllegalStateException("tile quota");}
            if(status==400){sessionExpiryMs=0L;throw new IllegalStateException("tile session invalid");}
            if(status<200||status>=300){readLimited(c.getErrorStream(),64*1024);throw new IllegalStateException("tile HTTP "+status);}
            byte[] png=readLimited(c.getInputStream(),MAX_TILE_BYTES);List<Seg> segs=vectorize(png,t);
            String etag=c.getHeaderField("ETag");if(ttl>0)CACHE.put(t.key,new CacheEntry(copySegs(segs),etag,now+ttl,now));else CACHE.remove(t.key);return new FetchResult(segs,false);
        } finally {if(state.connection==c)state.connection=null;try{c.disconnect();}catch(Throwable ignored){}}
    }

    private static List<Tile> window(Tile c,double bearing,double speed){
        ArrayList<Tile> out=new ArrayList<Tile>();int n=1<<c.z;
        if(speed>=4.0&&finite(bearing)){
            double b=((bearing%360.0)+360.0)%360.0;double rad=Math.toRadians(b);double sx=Math.sin(rad),sy=-Math.cos(rad);
            if(Math.abs(sx)>Math.abs(sy)){
                int dx=sx>=0?1:-1;for(int yy=-1;yy<=1;yy++){addTile(out,c.z,c.x,c.y+yy,n);addTile(out,c.z,c.x+dx,c.y+yy,n);}
            }else{
                int dy=sy>=0?1:-1;for(int xx=-1;xx<=1;xx++){addTile(out,c.z,c.x+xx,c.y,n);addTile(out,c.z,c.x+xx,c.y+dy,n);}
            }
        }else{
            for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++)addTile(out,c.z,c.x+dx,c.y+dy,n);
        }
        return out;
    }
    private static void addTile(List<Tile> out,int z,int x,int y,int n){if(y<0||y>=n)return;x=((x%n)+n)%n;String k=z+"/"+x+"/"+y;for(Tile t:out)if(t.key.equals(k))return;out.add(new Tile(z,x,y));}
    private static Tile tileFor(double lat,double lon,int z){int n=1<<z;double cl=Math.max(-85.05112878,Math.min(85.05112878,lat));double x=(normalizeLon(lon)+180.0)/360.0*n;double r=Math.toRadians(cl);double y=(1.0-Math.log(Math.tan(r)+1.0/Math.cos(r))/Math.PI)/2.0*n;return new Tile(z,clamp((int)Math.floor(x),0,n-1),clamp((int)Math.floor(y),0,n-1));}

    private static List<Seg> vectorize(byte[] png,Tile tile)throws Exception{
        Bitmap bm=BitmapFactory.decodeByteArray(png,0,png.length);if(bm==null)throw new IllegalStateException("bad PNG");
        try{
            int w=bm.getWidth(),h=bm.getHeight();if(w<32||h<32||w>1024||h>1024)throw new IllegalStateException("unexpected tile dimensions");
            int[] px=new int[w*h];bm.getPixels(px,0,w,0,0,w,h);int grid=tile.z<=15?2:4,gw=(w+grid-1)/grid,gh=(h+grid-1)/grid;byte[] sev=new byte[gw*gh];
            for(int gy=0;gy<gh;gy++)for(int gx=0;gx<gw;gx++){
                int jam=0,slow=0;int x0=gx*grid,y0=gy*grid,x1=Math.min(w,x0+grid),y1=Math.min(h,y0+grid);
                for(int y=y0;y<y1;y++)for(int x=x0;x<x1;x++){int s=classifyPixel(px[y*w+x]);if(s==2)jam++;else if(s==1)slow++;}
                if(jam>=2||(jam>=1&&slow>=1))sev[gy*gw+gx]=2;else if(slow>=2)sev[gy*gw+gx]=1;
            }
            // Remove isolated antialias/noise cells only; preserve thin connected roads.
            byte[] clean=sev.clone();for(int gy=0;gy<gh;gy++)for(int gx=0;gx<gw;gx++){int idx=gy*gw+gx,s=sev[idx];if(s==0)continue;int neighbors=0;for(int oy=-1;oy<=1;oy++)for(int ox=-1;ox<=1;ox++){if((ox|oy)==0)continue;int xx=gx+ox,yy=gy+oy;if(xx>=0&&xx<gw&&yy>=0&&yy<gh&&sev[yy*gw+xx]==s)neighbors++;}if(neighbors==0)clean[idx]=0;}
            ArrayList<Seg> out=new ArrayList<Seg>();traceSeverity(clean,gw,gh,grid,w,h,tile,2,out);traceSeverity(clean,gw,gh,grid,w,h,tile,1,out);return out;
        } finally {bm.recycle();}
    }

    private static int classifyPixel(int argb){
        int a=(argb>>>24)&255;if(a<45)return 0;int r=(argb>>>16)&255,g=(argb>>>8)&255,b=argb&255;int max=Math.max(r,Math.max(g,b)),min=Math.min(r,Math.min(g,b));int d=max-min;if(max<70||d<35)return 0;double sat=(double)d/(double)max;if(sat<0.28)return 0;double h;if(max==r)h=60.0*(((double)(g-b))/d%6.0);else if(max==g)h=60.0*(((double)(b-r))/d+2.0);else h=60.0*(((double)(r-g))/d+4.0);if(h<0)h+=360.0;if(h<=16.0||h>=344.0)return 2;if(h>=16.0&&h<=66.0)return 1;return 0;
    }

    private static void traceSeverity(byte[] sev,int gw,int gh,int grid,int w,int h,Tile tile,int wanted,List<Seg> out){
        HashSet<Long> used=new HashSet<Long>();
        for(int i=0;i<sev.length;i++){if(sev[i]!=wanted||degree(sev,gw,gh,i,wanted)==2)continue;for(int nb:neighbors(sev,gw,gh,i,wanted)){long ek=edgeKey(i,nb);if(used.contains(ek))continue;Seg s=traceEdge(sev,gw,gh,grid,w,h,tile,wanted,i,nb,used);if(s!=null)out.add(s);}}
        for(int i=0;i<sev.length;i++){if(sev[i]!=wanted)continue;for(int nb:neighbors(sev,gw,gh,i,wanted)){long ek=edgeKey(i,nb);if(used.contains(ek))continue;Seg s=traceEdge(sev,gw,gh,grid,w,h,tile,wanted,i,nb,used);if(s!=null)out.add(s);}}
    }
    private static Seg traceEdge(byte[] sev,int gw,int gh,int grid,int w,int h,Tile tile,int wanted,int start,int next,Set<Long> used){
        ArrayList<Integer> ids=new ArrayList<Integer>();ids.add(start);int prev=start,cur=next;used.add(edgeKey(prev,cur));int guard=0;
        while(guard++<4096){ids.add(cur);List<Integer> ns=neighbors(sev,gw,gh,cur,wanted);if(degree(sev,gw,gh,cur,wanted)!=2)break;int n0=ns.get(0)==prev?ns.get(1):ns.get(0);long ek=edgeKey(cur,n0);if(used.contains(ek))break;used.add(ek);prev=cur;cur=n0;if(cur==start)break;}
        if(ids.size()<3)return null;ArrayList<Pt> pts=new ArrayList<Pt>();for(Integer id:ids){int gx=id%gw,gy=id/gw;double px=Math.min(w-0.5,gx*grid+grid*0.5),py=Math.min(h-0.5,gy*grid+grid*0.5);pts.add(pixelToWgs(tile,px,py,w,h));}
        double len=length(pts);if(len<28.0)return null;pts=new ArrayList<Pt>(capPoints(simplify(pts,tile.z<=15?5.0:3.5),MAX_POINTS_PER_PATH));if(pts.size()<2)return null;return new Seg(wanted,pts);
    }
    private static int degree(byte[] s,int gw,int gh,int i,int wanted){int x=i%gw,y=i/gw,n=0;for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){if((dx|dy)==0)continue;int xx=x+dx,yy=y+dy;if(xx>=0&&xx<gw&&yy>=0&&yy<gh&&s[yy*gw+xx]==wanted)n++;}return n;}
    private static List<Integer> neighbors(byte[] s,int gw,int gh,int i,int wanted){int x=i%gw,y=i/gw;ArrayList<Integer> o=new ArrayList<Integer>(8);for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){if((dx|dy)==0)continue;int xx=x+dx,yy=y+dy;if(xx>=0&&xx<gw&&yy>=0&&yy<gh){int n=yy*gw+xx;if(s[n]==wanted)o.add(n);}}return o;}
    private static long edgeKey(int a,int b){int lo=Math.min(a,b),hi=Math.max(a,b);return (((long)lo)<<32)|(hi&0xffffffffL);}

    private static List<Seg> mergeAndBudget(List<Seg> input,int max){
        ArrayList<Seg> work=new ArrayList<Seg>();for(Seg s:input)if(s.pts.size()>=2&&s.lengthM>=28)work.add(s);
        Collections.sort(work,new Comparator<Seg>(){public int compare(Seg a,Seg b){if(a.sev!=b.sev)return b.sev-a.sev;return Double.compare(b.lengthM,a.lengthM);}});
        // Bound expensive endpoint comparisons before merging. Final output is only 36 paths.
        if(work.size()>256)work=new ArrayList<Seg>(work.subList(0,256));
        ArrayList<Seg> merged=new ArrayList<Seg>();
        for(Seg s:work){boolean joined=false;for(int i=0;i<merged.size();i++){Seg a=merged.get(i);if(a.sev!=s.sev)continue;List<Pt> m=joinIfClose(a.pts,s.pts,18.0);if(m!=null){List<Pt> q=capPoints(simplify(m,3.5),MAX_POINTS_PER_PATH);merged.set(i,new Seg(a.sev,new ArrayList<Pt>(q)));joined=true;break;}}if(!joined)merged.add(s);}
        Collections.sort(merged,new Comparator<Seg>(){public int compare(Seg a,Seg b){if(a.sev!=b.sev)return b.sev-a.sev;return Double.compare(b.lengthM,a.lengthM);}});
        if(merged.size()>max)merged=new ArrayList<Seg>(merged.subList(0,max));for(Seg s:merged){s.pts=capPoints(s.pts,MAX_POINTS_PER_PATH);s.lengthM=length(s.pts);}return merged;
    }
    private static List<Pt> joinIfClose(List<Pt>a,List<Pt>b,double max){Pt a0=a.get(0),a1=a.get(a.size()-1),b0=b.get(0),b1=b.get(b.size()-1);double d00=dist(a0,b0),d01=dist(a0,b1),d10=dist(a1,b0),d11=dist(a1,b1);double d=Math.min(Math.min(d00,d01),Math.min(d10,d11));if(d>max)return null;ArrayList<Pt> o=new ArrayList<Pt>();if(d==d10){o.addAll(a);o.addAll(b);}else if(d==d11){o.addAll(a);ArrayList<Pt> r=new ArrayList<Pt>(b);Collections.reverse(r);o.addAll(r);}else if(d==d00){ArrayList<Pt> r=new ArrayList<Pt>(a);Collections.reverse(r);o.addAll(r);o.addAll(b);}else{ o.addAll(b);o.addAll(a);}return o;}

    private static List<Pt> simplify(List<Pt> pts,double eps){if(pts.size()<=2)return pts;boolean[] keep=new boolean[pts.size()];keep[0]=keep[pts.size()-1]=true;ArrayList<int[]> stack=new ArrayList<int[]>();stack.add(new int[]{0,pts.size()-1});while(!stack.isEmpty()){int[] q=stack.remove(stack.size()-1);int best=-1;double bd=eps;for(int i=q[0]+1;i<q[1];i++){double d=pointSeg(pts.get(i),pts.get(q[0]),pts.get(q[1]));if(d>bd){bd=d;best=i;}}if(best>0){keep[best]=true;stack.add(new int[]{q[0],best});stack.add(new int[]{best,q[1]});}}ArrayList<Pt> out=new ArrayList<Pt>();for(int i=0;i<pts.size();i++)if(keep[i])out.add(pts.get(i));return out;}
    private static double pointSeg(Pt p,Pt a,Pt b){double lat=Math.toRadians(p.lat),kx=111320.0*Math.cos(lat),ky=110540.0,px=p.lon*kx,py=p.lat*ky,ax=a.lon*kx,ay=a.lat*ky,bx=b.lon*kx,by=b.lat*ky,vx=bx-ax,vy=by-ay,wx=px-ax,wy=py-ay,den=vx*vx+vy*vy,t=den>0?(wx*vx+wy*vy)/den:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-(ax+t*vx),py-(ay+t*vy));}
    private static Pt pixelToWgs(Tile t,double px,double py,int w,int h){double n=(double)(1<<t.z),wx=(t.x+px/w)/n,wy=(t.y+py/h)/n;double lon=wx*360.0-180.0,lat=Math.toDegrees(Math.atan(Math.sinh(Math.PI*(1.0-2.0*wy))));return new Pt(lat,lon);}
    private static double length(List<Pt> p){double m=0;for(int i=1;i<p.size();i++)m+=dist(p.get(i-1),p.get(i));return m;}
    private static double dist(Pt a,Pt b){double lat=Math.toRadians((a.lat+b.lat)*0.5),x=(b.lon-a.lon)*111320.0*Math.cos(lat),y=(b.lat-a.lat)*110540.0;return Math.hypot(x,y);}
    private static List<Seg> copySegs(List<Seg> in){ArrayList<Seg> o=new ArrayList<Seg>();for(Seg s:in)o.add(new Seg(s.sev,new ArrayList<Pt>(s.pts)));return o;}

    private static void setMobileHeaders(HttpsURLConnection c,String pkg,String cert){if(pkg!=null&&!pkg.isEmpty())c.setRequestProperty("X-Android-Package",pkg);if(cert!=null&&!cert.isEmpty())c.setRequestProperty("X-Android-Cert",cert);}
    private static List<Pt> capPoints(List<Pt> pts,int max){if(pts==null||pts.size()<=max)return pts;ArrayList<Pt> out=new ArrayList<Pt>(max);out.add(pts.get(0));int last=pts.size()-1,slots=max-2;for(int i=1;i<=slots;i++)out.add(pts.get((int)Math.round((double)i*last/(slots+1))));out.add(pts.get(last));return out;}

    private static byte[] readLimited(InputStream in,int max)throws Exception{if(in==null)return new byte[0];try{ByteArrayOutputStream out=new ByteArrayOutputStream(16384);byte[] b=new byte[8192];int n,total=0;while((n=in.read(b))!=-1){total+=n;if(total>max)throw new IllegalStateException("response too large");out.write(b,0,n);}return out.toByteArray();}finally{try{in.close();}catch(Throwable ignored){}}}
    private static long parseMaxAgeMs(String cc){if(cc==null)return -1;String[] p=cc.split(",");for(String x:p){String s=x.trim().toLowerCase();if(s.startsWith("max-age="))try{return Math.max(0,Long.parseLong(s.substring(8).trim()))*1000L;}catch(Exception ignored){}}return -1;}
    private static String enc(String s)throws Exception{return URLEncoder.encode(s,"UTF-8");}
    private static int clamp(int v,int lo,int hi){return Math.max(lo,Math.min(hi,v));}
    private static double normalizeLon(double lon){double x=((lon+180.0)%360.0+360.0)%360.0-180.0;return x;}
    private static boolean finite(double v){return !Double.isNaN(v)&&!Double.isInfinite(v);}
    private static boolean validCoord(double lat,double lon){return finite(lat)&&finite(lon)&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180;}
    private static String truncate(String s,int n){return s==null?"":s.substring(0,Math.min(n,s.length()));}
    private static double round6(double v){return Math.round(v*1000000.0)/1000000.0;}
}
