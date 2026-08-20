#!/usr/bin/env python3
import struct,sys
p=sys.argv[1]; b=bytearray(open(p,'rb').read())
pos0=8
_,hs,size=struct.unpack_from('<HHI',b,pos0)
sc,sty,flags,sp,ss=struct.unpack_from('<IIIII',b,pos0+8)
offs=[struct.unpack_from('<I',b,pos0+28+4*i)[0] for i in range(sc)]
data=pos0+sp
strings=[]
for o in offs:
 q=data+o; l=struct.unpack_from('<H',b,q)[0]; q+=2
 if l&0x8000:
  l=((l&0x7fff)<<16)|struct.unpack_from('<H',b,q)[0]; q+=2
 strings.append(b[q:q+l*2].decode('utf-16le','replace'))

def S(i): return strings[i] if 0<=i<len(strings) else None
pos=pos0+size; found=False
while pos<len(b):
 typ,hs,size=struct.unpack_from('<HHI',b,pos)
 if typ==0x0102:
  _,_,_,name=struct.unpack_from('<IIII',b,pos+8)
  attrStart,attrSize,attrCount,_,_,_=struct.unpack_from('<HHHHHH',b,pos+24)
  if S(name)=='application':
   base=pos+16+attrStart
   for i in range(attrCount):
    a=base+i*attrSize
    _,aname,raw=struct.unpack_from('<III',b,a)
    if S(aname)=='extractNativeLibs':
     # typed value: size u16, res0 u8, type u8, data u32
     vsize,res,vtype,vdata=struct.unpack_from('<HBBI',b,a+12)
     if vtype != 0x12: raise SystemExit(f'extractNativeLibs has unexpected type {vtype:#x}')
     struct.pack_into('<I',b,a+16,1)
     found=True
     print(f'patched application extractNativeLibs at file offset 0x{a+16:x}: {vdata} -> 1')
 if found: break
 pos+=size
if not found: raise SystemExit('extractNativeLibs attribute not found')
open(p,'wb').write(b)
