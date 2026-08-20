/* CairoDrive v22.3 native libGEM fast filter (arm64).
 * Search calls are handled by Google Places integration.
 * Only RoutingService.calculateRoute additionally enters the tiny navigation
 * preference rewriter. Everything else goes straight to stock libGEM.
 */
typedef void *(*cd_call_fn)(const char *, long long);
static cd_call_fn g_original = (cd_call_fn)0;
static cd_call_fn g_search_handler = (cd_call_fn)0;
static cd_call_fn g_route_handler = (cd_call_fn)0;

__attribute__((visibility("default"))) void cd_set_original(void *p) { g_original = (cd_call_fn)p; }
__attribute__((visibility("default"))) void cd_set_search_handler(void *p) { g_search_handler = (cd_call_fn)p; }
__attribute__((visibility("default"))) void cd_set_route_handler(void *p) { g_route_handler = (cd_call_fn)p; }

static int contains_token(const char *s, long long n, const char *t, int tn) {
  if (!s || !t || tn <= 0 || n < (long long)tn) return 0;
  for (long long i=0; i<=n-(long long)tn; ++i) {
    int j=0; for (; j<tn; ++j) if (s[i+j] != t[j]) break;
    if (j==tn) return 1;
  }
  return 0;
}

__attribute__((visibility("default"))) void *cd_native_call_filter(const char *request, long long len) {
  static const char search_class[] = "\"class\":\"SearchService\"";
  static const char search_method[] = "\"method\":\"search\"";
  static const char around_method[] = "\"method\":\"searchAroundPosition\"";
  static const char details_method[] = "\"method\":\"searchLandmarkDetails\"";
  static const char collection_class[] = "\"class\":\"LandmarkStoreCollection\"";
  static const char add_category_method[] = "\"method\":\"addStoreCategoryId\"";
  static const char routing_class[] = "\"class\":\"RoutingService\"";
  static const char calculate_method[] = "\"method\":\"calculateRoute";

  if (request && len > 0 && len < 1048576) {
    if (g_route_handler &&
        contains_token(request,len,routing_class,(int)(sizeof(routing_class)-1)) &&
        contains_token(request,len,calculate_method,(int)(sizeof(calculate_method)-1))) {
      return g_route_handler(request,len);
    }

    if (g_search_handler) {
      const int is_search = contains_token(request,len,search_class,(int)(sizeof(search_class)-1));
      const int is_collection = contains_token(request,len,collection_class,(int)(sizeof(collection_class)-1));
      if ((is_search &&
           (contains_token(request,len,search_method,(int)(sizeof(search_method)-1)) ||
            contains_token(request,len,around_method,(int)(sizeof(around_method)-1)) ||
            contains_token(request,len,details_method,(int)(sizeof(details_method)-1)))) ||
          (is_collection && contains_token(request,len,add_category_method,(int)(sizeof(add_category_method)-1)))) {
        return g_search_handler(request,len);
      }
    }
  }
  return g_original ? g_original(request,len) : (void *)0;
}
