package com.cairodrive.search;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
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

/** Cancellable, bounded, Google-only HTTPS workers for CairoDrive. */
public final class AsyncHttp {
    private static final AtomicLong NEXT = new AtomicLong(1L);
    private static final ConcurrentHashMap<Long, State> STATES = new ConcurrentHashMap<>();
    private static final ExecutorService PLACES_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final ExecutorService TRAFFIC_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int MAX_STATES = 32;
    private static final int MAX_REQUEST_BYTES = 512 * 1024;
    private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

    private AsyncHttp() {}
    private static final class State {
        volatile boolean done, cancelled;
        volatile int status;
        volatile String body, error;
        volatile Future<?> future;
        volatile HttpsURLConnection connection;
    }

    private static URL checkedUrl(String s) throws Exception {
        URL u = new URL(s);
        if (!"https".equalsIgnoreCase(u.getProtocol())) throw new SecurityException("HTTPS required");
        int port=u.getPort(); if (port != -1 && port != 443) throw new SecurityException("custom port blocked");
        String host=u.getHost(); String path=u.getPath()==null?"":u.getPath();
        boolean places="places.googleapis.com".equalsIgnoreCase(host) && path.startsWith("/v1/places");
        boolean routes="routes.googleapis.com".equalsIgnoreCase(host) && path.startsWith("/directions/v2");
        if (!places && !routes) throw new SecurityException("endpoint not allowlisted: "+host+path);
        return u;
    }
    private static void reap() {
        for (Map.Entry<Long,State> e: STATES.entrySet()) {
            State s=e.getValue(); if (s.done || s.cancelled) STATES.remove(e.getKey(),s);
        }
    }
    private static long newState(State s) {
        reap(); if (STATES.size() >= MAX_STATES) throw new IllegalStateException("too many pending HTTP states");
        long id=NEXT.getAndIncrement(); STATES.put(id,s); return id;
    }
    private static byte[] bodyBytes(String body) {
        byte[] b=(body==null?"{}":body).getBytes(StandardCharsets.UTF_8);
        if (b.length>MAX_REQUEST_BYTES) throw new IllegalArgumentException("request body too large");
        return b;
    }
    private static String readLimited(InputStream in, State state) throws Exception {
        if (in==null) return "";
        ByteArrayOutputStream out=new ByteArrayOutputStream(8192); byte[] buf=new byte[8192]; int total=0,n;
        while (!state.cancelled && (n=in.read(buf))!=-1) {
            total+=n; if (total>MAX_RESPONSE_BYTES) throw new IllegalStateException("response too large");
            out.write(buf,0,n);
        }
        in.close(); return out.toString("UTF-8");
    }
    private static void applyHeaders(HttpsURLConnection conn,String headersJson) throws Exception {
        JSONObject h=new JSONObject(headersJson==null?"{}":headersJson); Iterator<String> it=h.keys();
        while(it.hasNext()) { String k=it.next(); if (k.length()>128) continue; String kl=k.toLowerCase(java.util.Locale.US); if (kl.equals("host")||kl.equals("content-length")||kl.equals("connection")||kl.equals("transfer-encoding")) continue; String v=h.optString(k,""); conn.setRequestProperty(k,v.substring(0,Math.min(4096,v.length()))); }
    }

    public static long startPostJson(String url,String headers,String body,int c,int r) { return startPost(PLACES_EXECUTOR,url,headers,body,c,r); }
    public static long startTrafficPostJson(String url,String headers,String body,int c,int r) { return startPost(TRAFFIC_EXECUTOR,url,headers,body,c,r); }
    private static long startPost(final ExecutorService ex,final String us,final String hj,final String body,final int ct,final int rt) {
        final URL url; final byte[] bytes; try { url=checkedUrl(us); bytes=bodyBytes(body); } catch(Exception e) { throw new IllegalArgumentException(e); }
        final State state=new State(); final long id=newState(state);
        state.future=ex.submit(new Runnable(){@Override public void run(){ HttpsURLConnection conn=null; try {
            if(state.cancelled)return; conn=(HttpsURLConnection)url.openConnection(); state.connection=conn; conn.setRequestMethod("POST");
            conn.setConnectTimeout(Math.max(500,Math.min(15000,ct))); conn.setReadTimeout(Math.max(500,Math.min(20000,rt))); conn.setUseCaches(false);
            conn.setRequestProperty("Accept","application/json"); conn.setRequestProperty("Accept-Encoding","gzip"); applyHeaders(conn,hj);
            conn.setDoOutput(true); OutputStream os=conn.getOutputStream(); os.write(bytes); os.close(); if(state.cancelled)return;
            int status=conn.getResponseCode(); InputStream in=(status>=200&&status<300)?conn.getInputStream():conn.getErrorStream();
            if(in!=null && "gzip".equalsIgnoreCase(conn.getContentEncoding()))in=new GZIPInputStream(in);
            String result=readLimited(in,state); if(!state.cancelled){state.status=status;state.body=result;}
        } catch(Throwable t){if(!state.cancelled)state.error=t.getClass().getName()+": "+String.valueOf(t.getMessage());}
        finally { state.connection=null; if(conn!=null)try{conn.disconnect();}catch(Throwable ignored){} state.done=true; }} });
        return id;
    }

    public static long startGetJson(final String us,final String hj,final int ct,final int rt) {
        final URL url; try{url=checkedUrl(us);}catch(Exception e){throw new IllegalArgumentException(e);} final State state=new State(); final long id=newState(state);
        state.future=PLACES_EXECUTOR.submit(new Runnable(){@Override public void run(){HttpsURLConnection conn=null;try{
            if(state.cancelled)return;conn=(HttpsURLConnection)url.openConnection();state.connection=conn;conn.setRequestMethod("GET");
            conn.setConnectTimeout(Math.max(500,Math.min(15000,ct)));conn.setReadTimeout(Math.max(500,Math.min(20000,rt)));conn.setUseCaches(false);
            conn.setRequestProperty("Accept","application/json");conn.setRequestProperty("Accept-Encoding","gzip");applyHeaders(conn,hj);
            int status=conn.getResponseCode();InputStream in=(status>=200&&status<300)?conn.getInputStream():conn.getErrorStream();
            if(in!=null&&"gzip".equalsIgnoreCase(conn.getContentEncoding()))in=new GZIPInputStream(in);String result=readLimited(in,state);
            if(!state.cancelled){state.status=status;state.body=result;}
        }catch(Throwable t){if(!state.cancelled)state.error=t.getClass().getName()+": "+String.valueOf(t.getMessage());}
        finally{state.connection=null;if(conn!=null)try{conn.disconnect();}catch(Throwable ignored){}state.done=true;}}});return id;
    }

    public static String poll(long id){State s=STATES.get(id);if(s==null)return "CANCELLED";if(!s.done&&!s.cancelled)return null;STATES.remove(id);if(s.cancelled)return "CANCELLED";if(s.error!=null)return "ERR:"+s.error;return "OK:"+s.status+"\n"+(s.body==null?"":s.body);}
    public static void cancel(long id){State s=STATES.remove(id);if(s==null)return;s.cancelled=true;HttpsURLConnection c=s.connection;if(c!=null)try{c.disconnect();}catch(Throwable ignored){}Future<?> f=s.future;if(f!=null)f.cancel(true);s.done=true;}
    public static int pendingCount(){reap();return STATES.size();}
}
