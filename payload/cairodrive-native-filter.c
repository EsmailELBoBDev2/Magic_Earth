/* CairoDrive v24.3 native libGEM fast filter (arm64).
 * One shallow class/method lookup replaces repeated full-request scans.
 * Everything outside the tiny Search/Routing interception surface passes to stock.
 */
typedef void *(*cd_call_fn)(const char *, long long);
static cd_call_fn g_original=(cd_call_fn)0;
static cd_call_fn g_search_handler=(cd_call_fn)0;
static cd_call_fn g_route_handler=(cd_call_fn)0;

__attribute__((visibility("default"))) void cd_set_original(void *p){g_original=(cd_call_fn)p;}
__attribute__((visibility("default"))) void cd_set_search_handler(void *p){g_search_handler=(cd_call_fn)p;}
__attribute__((visibility("default"))) void cd_set_route_handler(void *p){g_route_handler=(cd_call_fn)p;}

static const char *find_lit(const char *s,long long n,const char *t,int tn){
  if(!s||!t||tn<=0||n<(long long)tn)return (const char*)0;
  const char first=t[0];
  for(long long i=0;i<=n-(long long)tn;i++){
    if(s[i]!=first)continue;
    int j=1;for(;j<tn;j++)if(s[i+j]!=t[j])break;
    if(j==tn)return s+i+tn;
  }
  return (const char*)0;
}
static int value_eq(const char *p,const char *v,int vn,const char *end){
  if(!p||!v||p+vn>end)return 0;
  for(int i=0;i<vn;i++)if(p[i]!=v[i])return 0;
  return p+vn<end && p[vn]=='\"';
}
static int value_prefix(const char *p,const char *v,int vn,const char *end){
  if(!p||!v||p+vn>end)return 0;
  for(int i=0;i<vn;i++)if(p[i]!=v[i])return 0;
  return 1;
}

__attribute__((visibility("default"))) void *cd_native_call_filter(const char *request,long long len){
  static const char class_key[]="\"class\":\"";
  static const char method_key[]="\"method\":\"";
  static const char routing[]="RoutingService";
  static const char search[]="SearchService";
  static const char collection[]="LandmarkStoreCollection";
  static const char calculate[]="calculateRoute";
  static const char m_search[]="search";
  static const char m_around[]="searchAroundPosition";
  static const char m_addcat[]="addStoreCategoryId";

  if(request&&len>0&&len<1048576){
    const char *end=request+len;
    const char *cls=find_lit(request,len,class_key,(int)(sizeof(class_key)-1));
    if(cls){
      if(g_route_handler&&value_eq(cls,routing,(int)(sizeof(routing)-1),end)){
        long long rem=(long long)(end-request);
        const char *m=find_lit(request,rem,method_key,(int)(sizeof(method_key)-1));
        if(m&&value_prefix(m,calculate,(int)(sizeof(calculate)-1),end))return g_route_handler(request,len);
      }else if(g_search_handler&&value_eq(cls,search,(int)(sizeof(search)-1),end)){
        const char *m=find_lit(request,len,method_key,(int)(sizeof(method_key)-1));
        if(m&&(value_eq(m,m_search,(int)(sizeof(m_search)-1),end)||value_eq(m,m_around,(int)(sizeof(m_around)-1),end)))return g_search_handler(request,len);
      }else if(g_search_handler&&value_eq(cls,collection,(int)(sizeof(collection)-1),end)){
        const char *m=find_lit(request,len,method_key,(int)(sizeof(method_key)-1));
        if(m&&value_eq(m,m_addcat,(int)(sizeof(m_addcat)-1),end))return g_search_handler(request,len);
      }
    }
  }
  return g_original?g_original(request,len):(void*)0;
}
