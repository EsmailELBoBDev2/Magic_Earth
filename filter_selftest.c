#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

static int orig_count, search_count, route_count;
static void *orig(const char *r,long long n){(void)r;(void)n;orig_count++;return (void*)(uintptr_t)1;}
static void *search(const char *r,long long n){(void)r;(void)n;search_count++;return (void*)(uintptr_t)2;}
static void *route(const char *r,long long n){(void)r;(void)n;route_count++;return (void*)(uintptr_t)3;}

#define __attribute__(x)
#include "payload/cairodrive-native-filter.c"
#undef __attribute__

static void reset(void){orig_count=search_count=route_count=0;}
int main(void){
  cd_set_original((void*)orig); cd_set_search_handler((void*)search); cd_set_route_handler((void*)route);
  const char *s="{\"class\":\"SearchService\",\"method\":\"search\",\"args\":{}}";
  reset(); assert(cd_native_call_filter(s,strlen(s))==(void*)(uintptr_t)2); assert(search_count==1&&route_count==0&&orig_count==0);
  const char *d="{\"class\":\"SearchService\",\"method\":\"searchLandmarkDetails\",\"args\":{\"landmark\":123}}";
  reset(); assert(cd_native_call_filter(d,strlen(d))==(void*)(uintptr_t)2); assert(search_count==1&&route_count==0&&orig_count==0);
  const char *r="{\"class\":\"RoutingService\",\"method\":\"calculateRoute\",\"args\":{}}";
  reset(); assert(cd_native_call_filter(r,strlen(r))==(void*)(uintptr_t)3); assert(route_count==1&&search_count==0&&orig_count==0);
  const char *n="{\"class\":\"NavigationService\",\"method\":\"getNavigationInstruction\",\"args\":{}}";
  reset(); assert(cd_native_call_filter(n,strlen(n))==(void*)(uintptr_t)1); assert(orig_count==1&&route_count==0&&search_count==0);
  puts("native-filter selftest: PASS");
  return 0;
}
